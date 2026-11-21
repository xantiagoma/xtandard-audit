/**
 * The tiny multi-tenant "team settings" app the framework examples share: an
 * in-memory database (two organizations, their members and invoices), a fake
 * session, the typed audit action catalog, the three user actions that record
 * audit events, and the HTML page. Kept separate so `index.ts` reads as pure
 * framework wiring.
 *
 * Nothing here is framework-specific: each action takes the signed-in user and
 * returns `{ status, body }`. The audit event is recorded right where the
 * action happens; the tenant, actor, IP, user agent and request id come from
 * the `auditContext` middleware, so `record()` only says *what* happened.
 */
import * as v from "valibot";
import { createAuditCore, defineActions } from "@xtandard/audit";
import type { AuditStorage } from "@xtandard/audit";

/** The typed catalog: `record()` autocompletes these and validates `metadata`. */
export const actions = defineActions({
  "member.invited": {
    group: "Members",
    description: "A member was invited to the organization",
    outcome: "success", // the default when record() passes none
    targets: ["user"],
    metadata: v.object({ role: v.picklist(["admin", "member", "viewer"]) }),
  },
  "member.role_changed": {
    group: "Members",
    description: "A member's role changed (or a change was refused)",
    outcome: "success", // the default when record() passes none
    targets: ["user"],
    metadata: v.object({ from: v.string(), to: v.string() }),
  },
  "invoice.paid": {
    group: "Billing",
    description: "An invoice was paid",
    outcome: "success", // the default when record() passes none
    targets: ["invoice"],
    metadata: v.object({ amount: v.number(), currency: v.string(), card: v.string() }),
  },
  "invoice.payment_failed": {
    group: "Billing",
    description: "A payment attempt was declined",
    targets: ["invoice"],
    outcome: "failure",
    metadata: v.object({
      amount: v.number(),
      currency: v.string(),
      card: v.string(),
      declineCode: v.string(),
    }),
  },
});

/** One audit core for the app; the panel reuses it (`auditPanel({ core })`). */
export function createAudit(storage: AuditStorage) {
  return createAuditCore({ storage, actions });
}

export type Audit = ReturnType<typeof createAudit>;

// ── The app's own data (in memory; resets on restart — the audit log does not) ──

type Role = "owner" | "admin" | "member" | "viewer";

export interface User {
  id: string;
  name: string;
  email: string;
  orgId: string;
  role: Role;
  status: "active" | "invited";
}

interface Invoice {
  id: string;
  orgId: string;
  number: string;
  amount: number;
  currency: string;
  status: "open" | "paid";
}

const orgs: Record<string, { name: string }> = {
  acme: { name: "Acme Corporation" },
  globex: { name: "Globex GmbH" },
};

const users: User[] = [
  {
    id: "usr_ada",
    name: "Ada Lovelace",
    email: "ada@acme.com",
    orgId: "acme",
    role: "owner",
    status: "active",
  },
  {
    id: "usr_grace",
    name: "Grace Hopper",
    email: "grace@acme.com",
    orgId: "acme",
    role: "admin",
    status: "active",
  },
  {
    id: "usr_alan",
    name: "Alan Turing",
    email: "alan@acme.com",
    orgId: "acme",
    role: "member",
    status: "active",
  },
  {
    id: "usr_hank",
    name: "Hank Scorpio",
    email: "hank@globex.de",
    orgId: "globex",
    role: "owner",
    status: "active",
  },
  {
    id: "usr_lena",
    name: "Lena Fischer",
    email: "lena@globex.de",
    orgId: "globex",
    role: "viewer",
    status: "active",
  },
];

const invoices: Invoice[] = [
  {
    id: "inv_acme_1",
    orgId: "acme",
    number: "INV-2026-0042",
    amount: 49_00,
    currency: "USD",
    status: "open",
  },
  {
    id: "inv_acme_2",
    orgId: "acme",
    number: "INV-2026-0043",
    amount: 1_250_00,
    currency: "USD",
    status: "open",
  },
  {
    id: "inv_globex_1",
    orgId: "globex",
    number: "INV-2026-0108",
    amount: 390_00,
    currency: "EUR",
    status: "open",
  },
];

/**
 * The fake session: an `x-demo-user` header, else a `demo_user` cookie (the
 * page's user switcher sets it), else Ada. Your real app reads its own
 * session / JWT here.
 */
export function currentUser(headers: Headers): User {
  const cookie = /(?:^|;\s*)demo_user=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1];
  const id = headers.get("x-demo-user") ?? cookie ?? "usr_ada";
  return users.find((u) => u.id === id) ?? users[0]!;
}

/** The actor an audit event is attributed to (what `auditContext` resolves). */
export const actorOf = (user: User) => ({ id: user.id, name: user.name, email: user.email });

/** A JSON response from a framework-agnostic action. */
export interface Result {
  status: number;
  body: unknown;
}

const canManage = (user: User) => user.role === "owner" || user.role === "admin";

/** `GET /api/me` — the signed-in user, their organization, its members and invoices. */
export function me(user: User): Result {
  return {
    status: 200,
    body: {
      user,
      org: { id: user.orgId, ...orgs[user.orgId] },
      members: users.filter((u) => u.orgId === user.orgId),
      invoices: invoices.filter((i) => i.orgId === user.orgId),
      switchTo: users.map((u) => ({ id: u.id, label: `${u.name} — ${u.role} @ ${u.orgId}` })),
    },
  };
}

/** `POST /api/members` — invite someone to the organization. */
export async function inviteMember(
  audit: Audit,
  user: User,
  input: { email?: string; role?: string },
): Promise<Result> {
  if (!canManage(user)) return { status: 403, body: { error: "only owners and admins invite" } };
  const email = input.email?.trim().toLowerCase();
  const role = input.role === "admin" || input.role === "viewer" ? input.role : "member";
  if (!email || !email.includes("@")) return { status: 400, body: { error: "email required" } };
  const member: User = {
    id: `usr_${crypto.randomUUID().slice(0, 8)}`,
    name: email.split("@")[0]!,
    email,
    orgId: user.orgId,
    role,
    status: "invited",
  };
  users.push(member);
  // The audit call: tenant, actor, IP, user agent and request id come from auditContext.
  const event = await audit.record({
    action: "member.invited",
    targets: [{ type: "user", id: member.id, name: member.email }],
    metadata: { role },
    description: `${user.name} invited ${member.email} as ${role}`,
  });
  return { status: 201, body: { member, auditEventId: event.id } };
}

/** `POST /api/members/:id/role` — change a member's role (refused attempts are audited too). */
export async function changeRole(
  audit: Audit,
  user: User,
  memberId: string,
  input: { role?: string },
): Promise<Result> {
  const member = users.find((u) => u.id === memberId && u.orgId === user.orgId);
  if (!member) return { status: 404, body: { error: "no such member" } };
  const to = input.role ?? "member";
  const from = member.role;
  const target = { type: "user", id: member.id, name: member.name };
  if (!canManage(user) || member.role === "owner" || !["admin", "member", "viewer"].includes(to)) {
    // Denied attempts are exactly what an auditor wants to see.
    await audit.record({
      action: "member.role_changed",
      outcome: "failure",
      targets: [target],
      metadata: { from, to },
      description: `${user.name} tried to change ${member.name}'s role to ${to} (denied)`,
    });
    return { status: 403, body: { error: "not allowed" } };
  }
  member.role = to as Role;
  const event = await audit.record({
    action: "member.role_changed",
    targets: [target],
    metadata: { from, to },
    description: `${user.name} changed ${member.name}'s role from ${from} to ${to}`,
  });
  return { status: 200, body: { member, auditEventId: event.id } };
}

/** `POST /api/invoices/:id/pay` — pay an invoice; card `…0002` is declined (Stripe-style test card). */
export async function payInvoice(
  audit: Audit,
  user: User,
  invoiceId: string,
  input: { card?: string },
): Promise<Result> {
  const invoice = invoices.find((i) => i.id === invoiceId && i.orgId === user.orgId);
  if (!invoice) return { status: 404, body: { error: "no such invoice" } };
  if (invoice.status === "paid") return { status: 409, body: { error: "already paid" } };
  const card = (input.card ?? "4242").slice(-4);
  const target = { type: "invoice", id: invoice.id, name: invoice.number };
  const money = { amount: invoice.amount, currency: invoice.currency, card };
  if (card === "0002") {
    const event = await audit.record({
      action: "invoice.payment_failed",
      targets: [target],
      metadata: { ...money, declineCode: "card_declined" },
      description: `Payment for ${invoice.number} declined (card •••• ${card})`,
    });
    return { status: 402, body: { error: "card declined", auditEventId: event.id } };
  }
  invoice.status = "paid";
  const event = await audit.record({
    action: "invoice.paid",
    targets: [target],
    metadata: money,
    description: `${user.name} paid ${invoice.number}`,
  });
  return { status: 200, body: { invoice, auditEventId: event.id } };
}

/** The page: a user switcher, the members and invoices of the org, and links to the log. */
export function renderDemoPage(panelPath = "/audit"): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Team settings — @xtandard/audit demo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2.5rem auto; padding: 0 1rem; color: #18181b; }
    h2 { margin-top: 2rem; font-size: 1.1rem; }
    table { width: 100%; border-collapse: collapse; }
    td, th { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #e4e4e7; font-size: 0.95rem; }
    input, select, button { font: inherit; padding: 0.3rem 0.6rem; }
    pre { background: #f4f4f5; padding: 0.75rem; overflow-x: auto; font-size: 0.85rem; }
    .muted { color: #71717a; }
  </style>
</head>
<body>
  <h1 id="org">Team settings</h1>
  <p>Signed in as <select id="who"></select> <span class="muted">(a fake session cookie)</span></p>
  <p class="muted">Every action below calls <code>audit.record()</code> where it happens; the
  <code>auditContext</code> middleware fills the tenant, actor, IP, user agent and request id.
  Watch them land in <a href="${panelPath}" target="_blank">the audit panel</a>.</p>

  <h2>Members</h2>
  <table id="members"></table>
  <form id="invite"><input name="email" type="email" placeholder="new.person@example.com" required />
    <select name="role"><option>member</option><option>admin</option><option>viewer</option></select>
    <button>Invite</button></form>

  <h2>Invoices</h2>
  <table id="invoices"></table>
  <p class="muted">Card <code>4242</code> succeeds; <code>0002</code> is declined (recorded with <code>outcome: "failure"</code>).</p>

  <h2>Last response</h2>
  <pre id="out">(do something)</pre>
  <script>
    const out = document.getElementById("out");
    async function call(method, url, body) {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
      out.textContent = res.status + " " + JSON.stringify(await res.json(), null, 2);
      await load();
    }
    async function load() {
      const me = await (await fetch("/api/me")).json();
      document.getElementById("org").textContent = me.org.name + " — team settings";
      const who = document.getElementById("who");
      who.innerHTML = me.switchTo.map((u) => '<option value="' + u.id + '"' + (u.id === me.user.id ? " selected" : "") + ">" + u.label + "</option>").join("");
      document.getElementById("members").innerHTML = me.members.map((m) =>
        "<tr><td>" + m.name + '</td><td class="muted">' + m.email + "</td><td>" + m.role + (m.status === "invited" ? " (invited)" : "") + "</td><td>" +
        (m.role === "owner" ? "" : '<select onchange="call(\\'POST\\', \\'/api/members/' + m.id + '/role\\', { role: this.value })">' +
          ["admin", "member", "viewer"].map((r) => "<option" + (r === m.role ? " selected" : "") + ">" + r + "</option>").join("") + "</select>") +
        "</td></tr>").join("");
      document.getElementById("invoices").innerHTML = me.invoices.map((i) =>
        "<tr><td>" + i.number + "</td><td>" + (i.amount / 100).toFixed(2) + " " + i.currency + "</td><td>" + i.status + "</td><td>" +
        (i.status === "paid" ? "" : '<button onclick="call(\\'POST\\', \\'/api/invoices/' + i.id + '/pay\\', { card: \\'4242\\' })">Pay ••4242</button> ' +
          '<button onclick="call(\\'POST\\', \\'/api/invoices/' + i.id + '/pay\\', { card: \\'0002\\' })">Pay ••0002</button>') +
        "</td></tr>").join("");
    }
    document.getElementById("who").addEventListener("change", (e) => {
      document.cookie = "demo_user=" + e.target.value + "; path=/";
      load();
    });
    document.getElementById("invite").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      call("POST", "/api/members", { email: f.get("email"), role: f.get("role") });
      e.target.reset();
    });
    load();
  </script>
</body>
</html>`;
}
