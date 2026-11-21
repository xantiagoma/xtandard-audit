/**
 * Seed a realistic, multi-tenant audit history — the dataset behind `bun run
 * demo` and the README/docs screenshots.
 *
 * The operator is a fictional developer platform; its customers are four
 * organizations with different plans, sizes and habits:
 *
 * | Tenant     | Customer              | Plan       | Story                                                          |
 * | ---------- | --------------------- | ---------- | -------------------------------------------------------------- |
 * | `acme`     | Acme Corporation      | Enterprise | Okta SSO enforced, CI deploys all day, weekly compliance CSVs  |
 * | `globex`   | Globex GmbH           | Business   | Azure AD SSO, a departure + a GDPR erasure, a bundle export    |
 * | `initech`  | Initech               | Team       | a declined card then a retry, a support impersonation session  |
 * | `umbrella` | Umbrella Health Ltd.  | Business   | converted from trial; 30-day retention → a pruned chain prefix |
 *
 * Six weeks of history (~1,500 events): logins (with MFA, the odd failure),
 * member invites / role changes / removals, invoices paid / failed /
 * refunded, plan changes, API keys created and revoked, SSO configuration,
 * projects, environment variables and deployments, exports and erasures. Every
 * event is recorded through `core.record()` with the clock set to when it
 * happened, so `recordedAt`, event ids and the automatic signed checkpoints
 * (daily, Ed25519) are spread over the timeline exactly like a real log.
 * Generation is deterministic (seeded PRNG): the same seed draws the same story.
 *
 * Used by `scripts/demo.ts`. Run directly to seed the storage configured by
 * the CLI's env contract, then serve it with the CLI:
 *
 *   bun scripts/seed-demo.ts                            # STORAGE_DRIVER=file → ./.audit
 *   STORAGE_DRIVER=sqlite bun scripts/seed-demo.ts
 *   AUDIT_SIGNING_KEY='<jwk>' bun scripts/seed-demo.ts  # sign with your key (else a fresh one is printed)
 *
 * @module
 */

import * as v from "valibot";
import { createAuditCore, type AuditCore } from "../src/core.ts";
import { exportEvents, type ExportFormat } from "../src/export.ts";
import type { AuditActor, AuditContext, AuditEventInput, AuditTarget } from "../src/schema.ts";
import { defineActions, type ActionMap, type ActionSpec } from "../src/standard-schema.ts";

// ── The action catalog ───────────────────────────────────────────────────────

const money = { amount: v.number(), currency: v.string() };

/**
 * The operator's typed action catalog: every action the demo records, with a
 * description, a UI group, the target types it carries and a metadata schema.
 */
export const DEMO_ACTIONS = defineActions({
  // Authentication
  "user.login": {
    group: "Authentication",
    description: "A user signed in",
    targets: [],
    metadata: v.object({ method: v.picklist(["password", "sso", "passkey"]), mfa: v.boolean() }),
  },
  "user.login_failed": {
    group: "Authentication",
    description: "A sign-in attempt was rejected",
    outcome: "failure",
    metadata: v.object({
      method: v.picklist(["password", "sso", "passkey"]),
      reason: v.picklist(["invalid_password", "mfa_failed", "account_locked"]),
    }),
  },
  "user.logout": { group: "Authentication", description: "A user signed out" },
  "user.mfa_enabled": {
    group: "Authentication",
    description: "A user enrolled a second factor",
    metadata: v.object({ factor: v.picklist(["totp", "webauthn"]) }),
  },
  "user.password_changed": {
    group: "Authentication",
    description: "A user changed their password",
  },
  // Members
  "member.invited": {
    group: "Members",
    description: "A member was invited to the organization",
    targets: ["user"],
    metadata: v.object({ role: v.string() }),
  },
  "member.invite_accepted": {
    group: "Members",
    description: "An invited member joined",
    targets: ["user"],
  },
  "member.role_changed": {
    group: "Members",
    description: "A member's role changed",
    targets: ["user"],
    metadata: v.object({ from: v.string(), to: v.string() }),
  },
  "member.removed": {
    group: "Members",
    description: "A member was removed from the organization",
    targets: ["user"],
    metadata: v.object({ reason: v.optional(v.string()) }),
  },
  // Billing
  "invoice.paid": {
    group: "Billing",
    description: "An invoice was paid",
    targets: ["invoice"],
    metadata: v.object({ ...money, attempt: v.number() }),
  },
  "invoice.payment_failed": {
    group: "Billing",
    description: "A payment attempt for an invoice failed",
    targets: ["invoice"],
    outcome: "failure",
    metadata: v.object({ ...money, attempt: v.number(), declineCode: v.string() }),
  },
  "invoice.refunded": {
    group: "Billing",
    description: "An invoice was (partially) refunded",
    targets: ["invoice"],
    metadata: v.object({ ...money, reason: v.string() }),
  },
  "subscription.plan_changed": {
    group: "Billing",
    description: "The organization changed plan",
    targets: ["subscription"],
    metadata: v.object({ from: v.string(), to: v.string(), seats: v.number() }),
  },
  "payment_method.updated": {
    group: "Billing",
    description: "The default payment method changed",
    metadata: v.object({ brand: v.string(), last4: v.string() }),
  },
  // API keys
  "api_key.created": {
    group: "API keys",
    description: "An API key was created",
    targets: ["api_key"],
    metadata: v.object({ scopes: v.array(v.string()), expiresInDays: v.optional(v.number()) }),
  },
  "api_key.revoked": {
    group: "API keys",
    description: "An API key was revoked",
    targets: ["api_key"],
    metadata: v.object({ reason: v.string() }),
  },
  // Single sign-on
  "sso.connection_configured": {
    group: "Single sign-on",
    description: "A SAML/OIDC connection was configured",
    targets: ["sso_connection"],
    metadata: v.object({ provider: v.string(), domains: v.array(v.string()) }),
  },
  "sso.enforced": {
    group: "Single sign-on",
    description: "Password sign-in was disabled in favor of SSO",
    targets: ["sso_connection"],
  },
  // Projects & deployments
  "project.created": {
    group: "Projects",
    description: "A project was created",
    targets: ["project"],
    metadata: v.object({ region: v.string() }),
  },
  "project.deleted": {
    group: "Projects",
    description: "A project was deleted",
    targets: ["project"],
  },
  "env_var.updated": {
    group: "Projects",
    description: "An environment variable was set (the value is never logged)",
    targets: ["project"],
    metadata: v.object({ key: v.string(), environment: v.string() }),
  },
  "deployment.created": {
    group: "Projects",
    description: "A deployment was started",
    targets: ["project", "deployment"],
    metadata: v.object({ environment: v.string(), commit: v.string(), branch: v.string() }),
  },
  "deployment.rolled_back": {
    group: "Projects",
    description: "A deployment was rolled back",
    targets: ["project", "deployment"],
    metadata: v.object({ environment: v.string(), toCommit: v.string() }),
  },
  // Operator support
  "support.impersonation_started": {
    group: "Support",
    description: "Operator support staff started an impersonation session",
    targets: ["user"],
    metadata: v.object({ ticket: v.string(), reason: v.string() }),
  },
  "support.impersonation_ended": {
    group: "Support",
    description: "An impersonation session ended",
    targets: ["user"],
    metadata: v.object({ ticket: v.string(), durationMinutes: v.number() }),
  },
  // Settings
  "settings.updated": {
    group: "Settings",
    description: "An organization setting changed",
    metadata: v.object({ setting: v.string(), from: v.string(), to: v.string() }),
  },
  "user.password_reset_requested": {
    group: "Authentication",
    description: "Superseded by user.password_changed (kept so old events still validate)",
    deprecated: true,
  },
});

/** The demo's action map type. */
export type DemoActions = typeof DEMO_ACTIONS;

// ── Tenants and people ───────────────────────────────────────────────────────

interface Person {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "billing" | "viewer";
  ip: string;
  userAgent: string;
  location: string;
  /** Day index (from the start of the history) the person joined; 0 = before it. */
  joined: number;
  /** Day index the person left (removed), if they do. */
  left?: number;
}

interface TenantSpec {
  key: string;
  name: string;
  domain: string;
  plan: string;
  currency: "USD" | "EUR" | "GBP";
  seatPrice: number;
  /** Hours added to UTC for the tenant's working day. */
  utcOffset: number;
  location: string;
  /** People present from day 0. */
  people: [name: string, role: Person["role"]][];
  /** Weekday deploys by the CI key. */
  deploysPerDay: number;
  projects: string[];
  billingDay: number;
}

/** The demo customers (tenant key → who they are). */
export const DEMO_TENANTS: TenantSpec[] = [
  {
    key: "acme",
    name: "Acme Corporation",
    domain: "acme.com",
    plan: "Enterprise",
    currency: "USD",
    seatPrice: 4900,
    utcOffset: -5,
    location: "New York, US",
    people: [
      ["Ada Lovelace", "owner"],
      ["Grace Hopper", "admin"],
      ["Alan Turing", "member"],
      ["Katherine Johnson", "member"],
      ["Linus Okafor", "member"],
      ["Margaret Hamilton", "admin"],
      ["Dennis Ritchie", "member"],
      ["Frances Allen", "billing"],
      ["Ken Thompson", "member"],
      ["Barbara Liskov", "viewer"],
    ],
    deploysPerDay: 6,
    projects: ["storefront", "payments-api", "data-pipeline"],
    billingDay: 1,
  },
  {
    key: "globex",
    name: "Globex GmbH",
    domain: "globex.de",
    plan: "Business",
    currency: "EUR",
    seatPrice: 3900,
    utcOffset: 1,
    location: "Berlin, DE",
    people: [
      ["Hank Scorpio", "owner"],
      ["Lena Fischer", "admin"],
      ["Jonas Becker", "member"],
      ["Mia Wagner", "member"],
      ["Felix Hoffmann", "member"],
      ["Sophie Schulz", "billing"],
      ["Tobias Klein", "member"],
    ],
    deploysPerDay: 3,
    projects: ["portal", "erp-sync"],
    billingDay: 15,
  },
  {
    key: "initech",
    name: "Initech",
    domain: "initech.io",
    plan: "Team",
    currency: "USD",
    seatPrice: 2900,
    utcOffset: -6,
    location: "Austin, US",
    people: [
      ["Bill Lumbergh", "owner"],
      ["Peter Gibbons", "member"],
      ["Samir Nagheenanajar", "member"],
      ["Michael Bolton", "admin"],
      ["Joanna Park", "member"],
    ],
    deploysPerDay: 2,
    projects: ["tps-reports"],
    billingDay: 8,
  },
  {
    key: "umbrella",
    name: "Umbrella Health Ltd.",
    domain: "umbrella-health.co.uk",
    plan: "Business",
    currency: "GBP",
    seatPrice: 3500,
    utcOffset: 0,
    location: "London, GB",
    people: [
      ["Alice Abernathy", "owner"],
      ["Carlos Oliveira", "admin"],
      ["Jill Valentine", "member"],
      ["Chris Redfield", "member"],
    ],
    deploysPerDay: 2,
    projects: ["patient-portal", "lab-results"],
    billingDay: 22,
  },
];

// ── Deterministic randomness ─────────────────────────────────────────────────

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
];

// ── The timeline ─────────────────────────────────────────────────────────────

/** One scheduled step of the story. */
type Step =
  | { at: number; kind: "record"; input: AuditEventInput; capture?: string }
  | { at: number; kind: "erase-actor"; tenant: string; actorId: string; reason: string; by: Person }
  | {
      at: number;
      kind: "erase";
      tenant: string;
      /** The `capture` label of the record step whose event is erased. */
      capture: string;
      sections: ("actor" | "targets" | "context" | "metadata" | "description")[];
      reason: string;
      by: Person;
    }
  | {
      at: number;
      kind: "export";
      tenant: string;
      format: ExportFormat;
      query: { actions?: string[]; from?: string };
      by: Person;
    }
  | { at: number; kind: "checkpoint"; tenant: string; by: Person };

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z ]/g, "")
    .split(" ")
    .join(".");

/** Options for {@link buildTimeline} / {@link seedDemo}. */
export interface SeedOptions {
  /** Days of history. Default 42. */
  days?: number;
  /** PRNG seed. Default 7790. */
  seed?: number;
  /** End of the history (unix ms). Default: now − 20 minutes. */
  end?: number;
}

function buildTimeline(options: SeedOptions = {}): Step[] {
  const rand = prng(options.seed ?? 7790);
  const days = options.days ?? 42;
  const end = options.end ?? Date.now() - 20 * MIN;
  // Day 0 starts at UTC midnight `days` days before the end.
  const start = Math.floor(end / DAY) * DAY - days * DAY;
  const steps: Step[] = [];

  const chance = (p: number) => rand() < p;
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  const id = (prefix: string, n = 10) =>
    `${prefix}_${Array.from({ length: n }, () => pick([..."0123456789abcdefghijkmnpqrstuvwxyz"])).join("")}`;

  for (const spec of DEMO_TENANTS) {
    const ipBase = pick(["203.0.113", "198.51.100", "192.0.2"]);
    const makePerson = (name: string, role: Person["role"], joined: number): Person => ({
      id: id("usr"),
      name,
      email: `${slug(name)}@${spec.domain}`,
      role,
      ip: `${ipBase}.${int(2, 250)}`,
      userAgent: pick(USER_AGENTS),
      location: spec.location,
      joined,
    });
    const people: Person[] = spec.people.map(([name, role]) => makePerson(name, role, 0));
    const owner = people[0]!;
    const admins = () =>
      people.filter((p) => (p.role === "owner" || p.role === "admin") && active(p));
    const billingPeople = () =>
      people.filter((p) => (p.role === "billing" || p.role === "owner") && active(p));
    let today = 0;
    const active = (p: Person) => p.joined <= today && (p.left === undefined || p.left > today);

    const ctx = (p: Person): AuditContext => ({
      ip: p.ip,
      userAgent: p.userAgent,
      requestId: `req_${hex(16)}`,
      location: p.location,
    });
    const actorOf = (p: Person): AuditActor => ({
      id: p.id,
      type: "user",
      name: p.name,
      email: p.email,
    });
    const userTarget = (p: Person): AuditTarget => ({ type: "user", id: p.id, name: p.name });
    /** A time on day `d`, at local hour `h` (fractional) of the tenant. */
    const at = (d: number, h: number) => Math.round(start + d * DAY + (h - spec.utcOffset) * HOUR);
    const workHour = () => 8 + rand() * 10;
    const rec = (
      time: number,
      input: Omit<AuditEventInput, "tenant">,
    ): AuditEventInput & { tenant: string } => {
      // Explicit outcomes everywhere (failures set their own), so the UI shows ✓ / ✗ per row.
      const full = {
        tenant: spec.key,
        occurredAt: new Date(time).toISOString(),
        outcome: "success" as const,
        ...input,
      };
      steps.push({ at: time, kind: "record", input: full });
      return full;
    };

    // Plan / tenant-specific story beats (day indexes).
    const ssoDay = spec.key === "acme" ? 3 : spec.key === "globex" ? 12 : -1;
    const ssoEnforcedDay = spec.key === "acme" ? 5 : -1;
    const ssoConnection: AuditTarget = {
      type: "sso_connection",
      id: id("conn"),
      name: spec.key === "acme" ? "Okta (acme.com)" : "Microsoft Entra ID (globex.de)",
    };
    const subscription: AuditTarget = {
      type: "subscription",
      id: id("sub", 14),
      name: `${spec.name} — ${spec.plan}`,
    };
    const projects = spec.projects.map(
      (name): AuditTarget => ({ type: "project", id: id("prj"), name }),
    );
    const ciKey: AuditTarget = { type: "api_key", id: id("key", 16), name: "ci-deploy" };
    const ciActor: AuditActor = { id: ciKey.id, type: "api_key", name: "ci-deploy" };
    const keys: AuditTarget[] = [ciKey];
    let invoiceNo = int(11, 40);
    const invoice = (): AuditTarget => ({
      type: "invoice",
      id: `in_${hex(24)}`,
      name: `INV-2026-${String(invoiceNo++).padStart(4, "0")}`,
    });
    const pendingInvites: { person: Person; acceptOn: number }[] = [];
    const invitees = [
      "Noor Haddad",
      "Wei Zhang",
      "Priya Raman",
      "Tomás García",
      "Emeka Obi",
      "Hana Sato",
      "Lars Nilsson",
      "Ines Moreau",
    ];

    for (let d = 0; d < days; d++) {
      today = d;
      const weekday = new Date(start + d * DAY).getUTCDay();
      const workday = weekday !== 0 && weekday !== 6;
      const activity = workday ? 1 : 0.15;

      // Invites accepted today.
      for (const pending of pendingInvites.filter((p) => p.acceptOn === d)) {
        const p = pending.person;
        rec(at(d, workHour()), {
          action: "member.invite_accepted",
          actor: actorOf(p),
          targets: [userTarget(p)],
          context: ctx(p),
          description: `${p.name} accepted the invitation and joined ${spec.name}`,
        });
      }

      // Sign-ins: most active people, most workdays.
      for (const p of people.filter(active)) {
        if (!chance(0.8 * activity)) continue;
        const ssoOn = ssoDay >= 0 && d >= ssoDay;
        const method = ssoOn ? "sso" : p.role === "owner" && chance(0.5) ? "passkey" : "password";
        const t = at(d, workHour());
        if (method === "password" && chance(0.05)) {
          rec(t - int(1, 4) * MIN, {
            action: "user.login_failed",
            actor: actorOf(p),
            context: ctx(p),
            outcome: "failure",
            metadata: { method, reason: chance(0.8) ? "invalid_password" : "mfa_failed" },
            description: `Failed sign-in for ${p.email}`,
          });
        }
        rec(t, {
          action: "user.login",
          actor: actorOf(p),
          context: ctx(p),
          metadata: { method, mfa: method !== "password" || chance(0.7) },
          description: `${p.name} signed in${method === "sso" ? " with SSO" : ""}`,
        });
        if (chance(0.25)) {
          rec(t + int(2, 8) * HOUR, {
            action: "user.logout",
            actor: actorOf(p),
            context: ctx(p),
            description: `${p.name} signed out`,
          });
        }
      }

      // CI deploys (an API key actor) — the bulk of a dev platform's log.
      if (workday) {
        const deploys = int(Math.max(0, spec.deploysPerDay - 2), spec.deploysPerDay + 2);
        for (let i = 0; i < deploys; i++) {
          const project = pick(projects);
          const deployment: AuditTarget = { type: "deployment", id: id("dpl", 12) };
          const env = chance(0.35) ? "production" : "preview";
          const commit = hex(7);
          rec(at(d, 9 + rand() * 9), {
            action: "deployment.created",
            actor: ciActor,
            targets: [project, deployment],
            context: { ip: "34.82.17.201", userAgent: "deploy-cli/3.4.1 (github-actions)" },
            metadata: {
              environment: env,
              commit,
              branch:
                env === "production"
                  ? "main"
                  : pick(["feat/checkout", "fix/timeout", "chore/deps", "feat/search"]),
            },
            description: `ci-deploy deployed ${project.name}@${commit} to ${env}`,
          });
          if (env === "production" && chance(0.04)) {
            const p = pick(admins());
            rec(at(d, 18 + rand() * 2), {
              action: "deployment.rolled_back",
              actor: actorOf(p),
              targets: [project, deployment],
              context: ctx(p),
              metadata: { environment: env, toCommit: hex(7) },
              description: `${p.name} rolled back ${project.name} in production`,
            });
          }
        }
      }

      // Occasional admin work.
      if (workday && chance(0.18)) {
        const by = pick(admins());
        const project = pick(projects);
        const key = pick([
          "DATABASE_URL",
          "STRIPE_SECRET_KEY",
          "SENTRY_DSN",
          "FEATURE_FLAGS",
          "REDIS_URL",
        ]);
        const environment = pick(["production", "preview", "development"]);
        rec(at(d, workHour()), {
          action: "env_var.updated",
          actor: actorOf(by),
          targets: [project],
          context: ctx(by),
          metadata: { key, environment },
          description: `${by.name} updated ${key} on ${project.name} (${environment})`,
        });
      }
      if (workday && chance(0.08) && invitees.length > 0 && d < days - 2) {
        const by = pick(admins());
        const name = invitees.splice(Math.floor(rand() * invitees.length), 1)[0]!;
        const role = chance(0.8) ? "member" : "viewer";
        const person = makePerson(name, role, d + int(1, 3));
        people.push(person);
        pendingInvites.push({ person, acceptOn: person.joined });
        rec(at(d, workHour()), {
          action: "member.invited",
          actor: actorOf(by),
          targets: [{ ...userTarget(person), metadata: { email: person.email } }],
          context: ctx(by),
          metadata: { role },
          description: `${by.name} invited ${person.email} as ${role}`,
        });
      }
      if (workday && chance(0.05)) {
        const by = pick(admins());
        const member = people.find((p) => active(p) && p.role === "member" && p.id !== by.id);
        if (member) {
          rec(at(d, workHour()), {
            action: "member.role_changed",
            actor: actorOf(by),
            targets: [userTarget(member)],
            context: ctx(by),
            metadata: { from: "member", to: "admin" },
            description: `${by.name} changed ${member.name}'s role from member to admin`,
          });
          member.role = "admin";
        }
      }
      if (workday && chance(0.04)) {
        const by = pick(admins());
        const scopes = pick([
          ["deployments:write"],
          ["projects:read", "deployments:read"],
          ["env:write", "deployments:write"],
        ]);
        const key: AuditTarget = {
          type: "api_key",
          id: id("key", 16),
          name: pick(["terraform", "grafana-export", "backstage", "local-dev", "zapier"]),
        };
        keys.push(key);
        rec(at(d, workHour()), {
          action: "api_key.created",
          actor: actorOf(by),
          targets: [key],
          context: ctx(by),
          metadata: { scopes, expiresInDays: pick([30, 90, 365]) },
          description: `${by.name} created API key "${key.name}"`,
        });
      }
      if (workday && chance(0.03) && keys.length > 1) {
        const by = pick(admins());
        const key = keys.splice(1 + Math.floor(rand() * (keys.length - 1)), 1)[0]!;
        rec(at(d, workHour()), {
          action: "api_key.revoked",
          actor: actorOf(by),
          targets: [key],
          context: ctx(by),
          metadata: { reason: pick(["rotation", "no longer used", "leaked in a public gist"]) },
          description: `${by.name} revoked API key "${key.name}"`,
        });
      }
      if (workday && chance(0.04)) {
        const p = pick(people.filter(active));
        if (chance(0.5)) {
          const factor = chance(0.6) ? "webauthn" : "totp";
          rec(at(d, workHour()), {
            action: "user.mfa_enabled",
            actor: actorOf(p),
            context: ctx(p),
            metadata: { factor },
            description: `${p.name} enrolled ${factor === "webauthn" ? "a security key" : "an authenticator app"}`,
          });
        } else {
          rec(at(d, workHour()), {
            action: "user.password_changed",
            actor: actorOf(p),
            context: ctx(p),
            description: `${p.name} changed their password`,
          });
        }
      }

      // Monthly invoice on the billing day (Stripe-like: the system actor charges).
      const dayOfMonth = new Date(start + d * DAY).getUTCDate();
      if (dayOfMonth === spec.billingDay) {
        const seats = people.filter(active).length;
        const amount = seats * spec.seatPrice;
        const inv = invoice();
        const system: AuditActor = { id: "system:billing", type: "system", name: "Billing" };
        const t = at(d, 6);
        if (spec.key === "initech") {
          rec(t, {
            action: "invoice.payment_failed",
            actor: system,
            targets: [inv],
            outcome: "failure",
            metadata: { amount, currency: spec.currency, attempt: 1, declineCode: "card_declined" },
            description: `Payment for ${inv.name} failed: card declined`,
          });
          const by = billingPeople()[0] ?? owner;
          rec(at(d, 10.5), {
            action: "payment_method.updated",
            actor: actorOf(by),
            context: ctx(by),
            metadata: { brand: "visa", last4: "4242" },
            description: `${by.name} replaced the default card (visa •••• 4242)`,
          });
          rec(at(d, 11), {
            action: "invoice.paid",
            actor: system,
            targets: [inv],
            metadata: { amount, currency: spec.currency, attempt: 2 },
            description: `${inv.name} paid on retry`,
          });
        } else {
          rec(t, {
            action: "invoice.paid",
            actor: system,
            targets: [inv],
            metadata: { amount, currency: spec.currency, attempt: 1 },
            description: `${inv.name} paid (${seats} seats)`,
          });
          if (spec.key === "acme") {
            const by = people.find((p) => p.role === "billing") ?? owner;
            rec(at(d + 2, 14), {
              action: "invoice.refunded",
              actor: { id: "usr_ops_rivera", type: "operator", name: "Sam Rivera (Finance)" },
              targets: [inv],
              metadata: {
                amount: spec.seatPrice,
                currency: spec.currency,
                reason: "seat billed twice",
              },
              description: `Refunded one seat on ${inv.name} after a request by ${by.name}`,
            });
          }
        }
      }

      // Story beats.
      if (d === ssoDay) {
        const by = admins()[0] ?? owner;
        rec(at(d, 15), {
          action: "sso.connection_configured",
          actor: actorOf(by),
          targets: [ssoConnection],
          context: ctx(by),
          metadata: {
            provider: spec.key === "acme" ? "okta" : "entra-id",
            domains: [spec.domain],
          },
          description: `${by.name} configured ${ssoConnection.name}`,
        });
      }
      if (d === ssoEnforcedDay) {
        rec(at(d, 9.5), {
          action: "sso.enforced",
          actor: actorOf(owner),
          targets: [ssoConnection],
          context: ctx(owner),
          description: `${owner.name} enforced SSO for every member`,
        });
        rec(at(d, 9.6), {
          action: "settings.updated",
          actor: actorOf(owner),
          context: ctx(owner),
          metadata: { setting: "session_timeout", from: "7d", to: "12h" },
          description: `${owner.name} shortened the session timeout to 12h`,
        });
      }
      if (spec.key === "umbrella" && d === 10) {
        rec(at(d, 16), {
          action: "subscription.plan_changed",
          actor: actorOf(owner),
          targets: [subscription],
          context: ctx(owner),
          metadata: { from: "Trial", to: "Business", seats: people.filter(active).length },
          description: `${owner.name} upgraded from Trial to Business`,
        });
      }
      if (spec.key === "acme" && d === 20) {
        rec(at(d, 11), {
          action: "subscription.plan_changed",
          actor: actorOf(owner),
          targets: [subscription],
          context: ctx(owner),
          metadata: { from: "Enterprise", to: "Enterprise", seats: 25 },
          description: `${owner.name} expanded the Enterprise plan to 25 seats`,
        });
      }
      if (d === 1 || (spec.key === "acme" && d === 25)) {
        const by = admins()[0] ?? owner;
        const region = pick(["us-east-1", "eu-central-1", "eu-west-2"]);
        const project: AuditTarget = {
          type: "project",
          id: id("prj"),
          name: `${pick(["billing", "search", "mobile", "ml"])}-${pick(["service", "worker", "gateway"])}`,
        };
        projects.push(project);
        rec(at(d, 13), {
          action: "project.created",
          actor: actorOf(by),
          targets: [project],
          context: ctx(by),
          metadata: { region },
          description: `${by.name} created project ${project.name} in ${region}`,
        });
        if (spec.key === "acme" && d === 25) {
          rec(at(d + 6, 10), {
            action: "project.deleted",
            actor: actorOf(by),
            targets: [project],
            context: ctx(by),
            description: `${by.name} deleted project ${project.name}`,
          });
        }
      }
      // A departure (globex) → removal, then a GDPR erasure of their personal data a week later.
      if (spec.key === "globex" && d === 18) {
        const leaver = people.find((p) => p.name === "Felix Hoffmann")!;
        const by = people.find((p) => p.name === "Lena Fischer")!;
        leaver.left = d + 1;
        rec(at(d, 17), {
          action: "member.removed",
          actor: actorOf(by),
          targets: [userTarget(leaver)],
          context: ctx(by),
          metadata: { reason: "left the company" },
          description: `${by.name} removed ${leaver.name}`,
        });
        steps.push({
          at: at(d + 7, 10),
          kind: "erase-actor",
          tenant: spec.key,
          actorId: leaver.id,
          reason: "GDPR Art. 17 request DSR-2026-114 (former employee)",
          by,
        });
      }
      if (spec.key === "acme" && d === 30) {
        const leaver = people.find((p) => p.name === "Linus Okafor")!;
        leaver.left = d + 1;
        rec(at(d, 16), {
          action: "member.removed",
          actor: actorOf(owner),
          targets: [userTarget(leaver)],
          context: ctx(owner),
          metadata: { reason: "contract ended" },
          description: `${owner.name} removed ${leaver.name}`,
        });
      }
      // initech: a mistaken invite to a personal address, erased on request.
      if (spec.key === "initech" && d === 9) {
        const by = people.find((p) => p.name === "Michael Bolton")!;
        const wrong = makePerson("Peter Gibbons", "member", d);
        wrong.email = "peter.gibbons1987@example.com";
        rec(at(d, 10), {
          action: "member.invited",
          actor: actorOf(by),
          targets: [{ ...userTarget(wrong), metadata: { email: wrong.email } }],
          context: ctx(by),
          metadata: { role: "member" },
          description: `${by.name} invited ${wrong.email} as member`,
        });
        (steps[steps.length - 1] as { capture?: string }).capture = "wrong-invite";
        steps.push({
          at: at(d + 1, 9),
          kind: "erase",
          tenant: spec.key,
          capture: "wrong-invite",
          sections: ["targets", "description"],
          reason: "Invited a personal address by mistake — erased at the invitee's request",
          by: owner,
        });
      }
      // initech: operator support impersonation for a ticket.
      if (spec.key === "initech" && d === 23) {
        const user = people.find((p) => p.name === "Peter Gibbons")!;
        const support: AuditActor = {
          id: "staff_jordan",
          type: "support",
          name: "Jordan Lee (Support)",
          email: "jordan.lee@support.example",
        };
        const supportCtx: AuditContext = {
          ip: "10.20.0.14",
          userAgent: USER_AGENTS[1],
          requestId: `req_${hex(16)}`,
        };
        rec(at(d, 14), {
          action: "support.impersonation_started",
          actor: support,
          targets: [userTarget(user)],
          context: supportCtx,
          metadata: { ticket: "SUP-4821", reason: "TPS report export stuck in 'processing'" },
          description: `Jordan Lee (Support) started a session as ${user.name} for SUP-4821`,
        });
        rec(at(d, 14.4), {
          action: "support.impersonation_ended",
          actor: support,
          targets: [userTarget(user)],
          context: supportCtx,
          metadata: { ticket: "SUP-4821", durationMinutes: 24 },
          description: "Support session for SUP-4821 ended after 24 minutes",
        });
      }

      // Exports: acme compliance pulls a CSV of member + auth activity every Monday;
      // globex downloads a verifiable bundle once.
      if (spec.key === "acme" && weekday === 1) {
        const by = people.find((p) => p.name === "Margaret Hamilton")!;
        steps.push({
          at: at(d, 9.25),
          kind: "export",
          tenant: spec.key,
          format: "csv",
          query: {
            actions: ["member.*", "user.*", "sso.*"],
            from: new Date(start + (d - 7) * DAY).toISOString(),
          },
          by,
        });
      }
      if (spec.key === "globex" && d === 33) {
        steps.push({
          at: at(d, 11),
          kind: "export",
          tenant: spec.key,
          format: "bundle",
          query: {},
          by: people.find((p) => p.name === "Hank Scorpio")!,
        });
      }
      if (spec.key === "umbrella" && d === 28) {
        steps.push({ at: at(d, 12), kind: "checkpoint", tenant: spec.key, by: owner });
      }
    }
  }

  return steps.filter((s) => s.at < end).sort((a, b) => a.at - b.at);
}

// ── Clock + seeding ──────────────────────────────────────────────────────────

/** A clock the seed can move through history, then hand back to real time. */
export interface DemoClock {
  now(): number;
  /** Pin the clock to `ms`. */
  set(ms: number): void;
  /** Follow real time again. */
  release(): void;
}

/** Create a {@link DemoClock} (pass `clock.now` as the core's `now`). */
export function demoClock(): DemoClock {
  let pinned: number | null = null;
  return {
    now: () => pinned ?? Date.now(),
    set: (ms) => {
      // Whole milliseconds, like Date.now(): event ids encode the clock.
      pinned = Math.round(ms);
    },
    release: () => {
      pinned = null;
    },
  };
}

/** What {@link seedDemo} did. */
export interface SeedSummary {
  events: Record<string, number>;
  exports: number;
  erasures: number;
  checkpoints: Record<string, number>;
  pruned: Record<string, number>;
}

/**
 * Replay the demo timeline into `core`, moving `clock` along it (the core must
 * have been created with `now: clock.now`). Ends by releasing the clock and
 * running retention once, so a tenant with a short retention window shows a
 * pruned, base-anchored chain.
 */
export async function seedDemo<A extends ActionMap>(
  typedCore: AuditCore<A>,
  clock: DemoClock,
  options: SeedOptions & { log?: (line: string) => void } = {},
): Promise<SeedSummary> {
  // The timeline is built from plain inputs; the core still validates them against its catalog.
  const core = typedCore as unknown as AuditCore<ActionMap>;
  const log = options.log ?? (() => {});
  const steps = buildTimeline(options);
  const summary: SeedSummary = { events: {}, exports: 0, erasures: 0, checkpoints: {}, pruned: {} };
  const operator = (p: Person) => ({ actor: { id: p.id, name: p.name, email: p.email } });
  const captured = new Map<string, string>();
  let done = 0;
  for (const step of steps) {
    clock.set(step.at);
    switch (step.kind) {
      case "record": {
        const event = await core.record(step.input);
        if (step.capture) captured.set(step.capture, event.id);
        summary.events[step.input.tenant] = (summary.events[step.input.tenant] ?? 0) + 1;
        break;
      }
      case "erase-actor":
        await core.eraseActor(
          step.tenant,
          step.actorId,
          { reason: step.reason },
          operator(step.by),
        );
        summary.erasures++;
        break;
      case "erase":
        await core.erase(
          step.tenant,
          captured.get(step.capture)!,
          { sections: step.sections, reason: step.reason },
          operator(step.by),
        );
        summary.erasures++;
        break;
      case "export": {
        const stream = await exportEvents(
          core,
          { tenant: step.tenant, ...step.query },
          { format: step.format, ...operator(step.by) },
        );
        await new Response(stream).arrayBuffer(); // drain it, like a download would
        summary.exports++;
        break;
      }
      case "checkpoint":
        await core.checkpoint(step.tenant, operator(step.by));
        break;
    }
    // Automatic checkpoints run in the background — let them land at this point in time.
    await core.settled();
    if (++done % 250 === 0) log(`  … ${done}/${steps.length} steps`);
  }
  clock.release();
  for (const result of await core.prune({ actor: { id: "system:retention", name: "Retention" } })) {
    if (result.pruned > 0) summary.pruned[result.tenant] = result.pruned;
  }
  await core.settled();
  for (const tenant of DEMO_TENANTS) {
    summary.checkpoints[tenant.key] = (await core.listCheckpoints(tenant.key)).length;
  }
  return summary;
}

/** Core options the demo uses (checkpoint cadence + retention), shared with the direct run. */
export const DEMO_CORE_OPTIONS = {
  checkpoints: { every: 250, interval: "1d" },
  // Enterprise keeps a year; Umbrella's plan keeps 30 days → a pruned, base-anchored chain.
  retention: { maxAge: "365d", tenants: { umbrella: { maxAge: "30d" } } },
} as const;

// ── Direct run: seed the CLI-configured storage ──────────────────────────────

if (import.meta.main) {
  const { buildStorage, signerFromEnv } = await import("../src/cli.ts");
  const { ed25519Signer, generateSigningKeyPair } = await import("../src/integrity.ts");
  process.env.STORAGE_DRIVER ??= "file";
  let signer = await signerFromEnv();
  if (!signer) {
    const pair = await generateSigningKeyPair();
    signer = await ed25519Signer(pair.privateJwk);
    console.log("No AUDIT_SIGNING_KEY set — generated one. Serve with the same key:\n");
    console.log(`  export AUDIT_SIGNING_KEY='${JSON.stringify(pair.privateJwk)}'\n`);
  }
  const clock = demoClock();
  const core = createAuditCore({
    storage: await buildStorage(),
    actions: DEMO_ACTIONS,
    signer,
    now: clock.now,
    ...DEMO_CORE_OPTIONS,
  });
  if ((await core.listTenants()).some((t) => DEMO_TENANTS.some((d) => d.key === t.key))) {
    console.error("This storage already holds demo tenants — point it at an empty store.");
    process.exit(1);
  }
  // The CLI's `serve` has no code catalog: persist ours so its UI shows descriptions/groups.
  for (const [name, spec] of Object.entries(DEMO_ACTIONS) as [string, ActionSpec][]) {
    await core.upsertAction({
      name,
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.group ? { group: spec.group } : {}),
      ...(spec.targets ? { targets: [...spec.targets] } : {}),
      ...(spec.deprecated ? { deprecated: true } : {}),
    });
  }
  console.log(`Seeding ${process.env.STORAGE_DRIVER} storage …`);
  const summary = await seedDemo(core, clock, {
    log: console.log,
  });
  console.log(summary);
  console.log("\nServe it:  RETENTION_MAX_AGE=365d bun src/cli.ts serve");
  process.exit(0);
}
