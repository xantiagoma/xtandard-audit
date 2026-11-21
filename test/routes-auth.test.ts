import { describe, expect, test } from "vitest";
import { basicAuth } from "../src/auth/basic.ts";
import { delegatedAuth } from "../src/auth/delegated.ts";
import type { AuthorizeInput } from "../src/authorization/contract.ts";
import { delegatedAuthorization } from "../src/authorization/delegated.ts";
import { rolesAuthorization } from "../src/authorization/roles.ts";
import { createPortalToken } from "../src/portal.ts";
import type { AuditEvent, AuditPage } from "../src/schema.ts";
import { callbackSink } from "../src/streams.ts";
import { bearer, call, evt, makePanel } from "./panel-fixtures.ts";

const basic = (user: string, pass: string) => ({
  authorization: `Basic ${btoa(`${user}:${pass}`)}`,
});

const SECRET = "portal-secret";

async function portalPanel(options: Parameters<typeof makePanel>[0] = {}) {
  const panel = makePanel({
    auth: delegatedAuth({ authenticate: () => null }), // the host's auth rejects everyone
    authorization: delegatedAuthorization({ authorize: () => false }),
    portal: { secret: SECRET },
    ...options,
  });
  await panel.core.recordMany([
    {
      tenant: "acme",
      action: "invoice.paid",
      actor: { id: "u1" },
      targets: [{ type: "invoice", id: "i1" }],
    },
    { tenant: "acme", action: "invoice.refunded", actor: { id: "u2" } },
    { tenant: "acme", action: "support.impersonate", actor: { id: "staff" } },
    { tenant: "acme", action: "user.login", actor: { id: "u1" } },
    { tenant: "globex", action: "user.login", actor: { id: "g1" } },
  ]);
  return panel;
}

describe("authentication", () => {
  const users = [
    { username: "admin", password: "pw", roles: ["admin"] },
    { username: "viewer", password: "pw", roles: ["viewer"] },
  ];

  test("unauthenticated requests get the provider's challenge", async () => {
    const panel = makePanel({ auth: basicAuth({ users }), authorization: rolesAuthorization() });
    const { status, res } = await call(panel, "/api/tenants");
    expect(status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  test("without a challenge, a plain JSON 401", async () => {
    const panel = makePanel({ auth: delegatedAuth({ authenticate: () => null }) });
    const { status, body } = await call<{ error: string }>(panel, "/api/tenants");
    expect(status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  test("/config is public and reports a null principal", async () => {
    const panel = makePanel({ auth: basicAuth({ users }), authorization: rolesAuthorization() });
    const { status, body } = await call<{ principal: unknown; allowed: string[] }>(
      panel,
      "/config",
    );
    expect(status).toBe(200);
    expect(body.principal).toBeNull();
    expect(body.allowed).toEqual([]);
  });

  test("a throwing auth provider is a 500, not a 401", async () => {
    const panel = makePanel({
      auth: delegatedAuth({
        authenticate: () => {
          throw new Error("IdP down");
        },
      }),
    });
    const { status, body } = await call<{ error: string }>(panel, "/api/tenants");
    expect(status).toBe(500);
    expect(body.error).toBe("IdP down");
  });
});

describe("authorization", () => {
  const users = [
    { username: "admin", password: "pw", roles: ["admin"] },
    { username: "viewer", password: "pw", roles: ["viewer"] },
    { username: "auditor", password: "pw", roles: ["auditor"] },
  ];
  const panel = () =>
    makePanel({ auth: basicAuth({ users }), authorization: rolesAuthorization() });

  test("viewer reads but cannot record, erase or export (403 with the action)", async () => {
    const p = panel();
    expect((await call(p, "/api/tenants", { headers: basic("viewer", "pw") })).status).toBe(200);
    const rec = await call<{ action: string }>(p, "/api/tenants/acme/events", {
      body: evt("a.b"),
      headers: basic("viewer", "pw"),
    });
    expect(rec.status).toBe(403);
    expect(rec.body.action).toBe("event:record");
    const exp = await call(p, "/api/tenants/acme/export", { headers: basic("viewer", "pw") });
    expect(exp.status).toBe(403);
  });

  test("/config lists exactly what the provider grants", async () => {
    const p = panel();
    const { body } = await call<{ allowed: string[]; principal: { id: string } }>(p, "/config", {
      headers: basic("auditor", "pw"),
    });
    expect(body.principal.id).toBe("auditor");
    expect(body.allowed).toContain("event:export");
    expect(body.allowed).toContain("integrity:checkpoint");
    expect(body.allowed).not.toContain("event:erase");
  });

  test("control-plane actions are attributed to the principal", async () => {
    const p = panel();
    const created = await call<AuditEvent>(p, "/api/tenants/acme/events", {
      body: evt("a.b"),
      headers: basic("admin", "pw"),
    });
    await call(p, `/api/tenants/acme/events/${created.body.id}/erase`, {
      body: { sections: ["metadata"] },
      headers: basic("admin", "pw"),
    });
    const { body } = await call<AuditPage>(p, "/api/tenants/acme/events?actions=audit_log.erased", {
      headers: basic("admin", "pw"),
    });
    expect(body.items[0]!.actor).toMatchObject({ id: "admin", name: "admin", type: "operator" });
  });

  test("resources carry the tenant / event / name the route acts on", async () => {
    const seen: AuthorizeInput[] = [];
    const p = makePanel({
      authorization: delegatedAuthorization({
        authorize: (input) => {
          seen.push(input);
          return true;
        },
      }),
    });
    await call(p, "/api/tenants/acme/events", { body: evt("a.b") });
    await call(p, "/api/events?tenant=acme");
    await call(p, "/api/events");
    await call(p, "/api/tenants/acme/verify");
    await call(p, "/api/actions/x.y", { method: "PUT", body: {} });
    await call(p, "/api/prune", { method: "POST" });
    await call(p, "/api/streams");
    expect(seen.map((s) => [s.action, s.resource])).toEqual([
      ["event:record", { type: "event", tenant: "acme" }],
      ["event:read", { type: "event", tenant: "acme" }],
      ["event:read", { type: "event" }],
      ["integrity:read", { type: "integrity", tenant: "acme" }],
      ["action:update", { type: "action", name: "x.y" }],
      ["retention:prune", { type: "retention" }],
      ["stream:read", { type: "stream" }],
    ]);
  });

  test("a throwing authorization provider maps to 500 (and grants nothing in /config)", async () => {
    const p = makePanel({
      authorization: delegatedAuthorization({
        authorize: () => {
          throw new Error("policy engine down");
        },
      }),
    });
    expect((await call(p, "/api/tenants")).status).toBe(500);
    expect((await call<{ allowed: string[] }>(p, "/config")).body.allowed).toEqual([]);
  });
});

describe("portal tokens", () => {
  test("an invalid or expired token is a 401, never a fallback to host auth", async () => {
    const panel = await portalPanel();
    const bad = await call<{ code: string }>(panel, "/api/tenants/acme/events", {
      headers: bearer("audpt_bogus.sig"),
    });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("PORTAL_TOKEN");
    const other = await createPortalToken("other-secret", "acme");
    expect((await call(panel, "/config", { headers: bearer(other) })).status).toBe(401);
  });

  test("/config renders portal chrome with the default grant", async () => {
    const panel = await portalPanel();
    const token = await createPortalToken(SECRET, "acme");
    const { body } = await call<Record<string, unknown>>(panel, "/config", {
      headers: bearer(token),
    });
    expect(body).toMatchObject({ portal: true, tenant: "acme", principal: { id: "portal:acme" } });
    expect([...(body.allowed as string[])].sort()).toEqual([
      "action:read",
      "event:export",
      "event:read",
      "integrity:read",
    ]);
  });

  test("is force-scoped to its tenant; the host's providers are bypassed", async () => {
    const panel = await portalPanel();
    const h = { headers: bearer(await createPortalToken(SECRET, "acme")) };
    const own = await call<AuditPage>(panel, "/api/tenants/acme/events", h);
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(4);
    expect((await call(panel, "/api/tenants/globex/events", h)).status).toBe(403);
    expect((await call(panel, "/api/tenants", h)).status).toBe(403);
    expect((await call(panel, "/api/overview", h)).status).toBe(403);
    expect((await call(panel, "/api/actions", h)).status).toBe(200);
    expect((await call(panel, "/api/tenants/acme/verify", h)).status).toBe(200);
    expect((await call(panel, "/api/tenants/acme/checkpoints", h)).status).toBe(200);
    // Nothing mutating by default.
    expect((await call(panel, "/api/tenants/acme/events", { ...h, body: evt("a.b") })).status).toBe(
      403,
    );
  });

  test("the cross-tenant listing is forced to the token's tenant", async () => {
    const panel = await portalPanel();
    const h = { headers: bearer(await createPortalToken(SECRET, "acme")) };
    const all = await call<AuditPage>(panel, "/api/events", h);
    expect(new Set(all.body.items.map((e) => e.tenant))).toEqual(new Set(["acme"]));
    const other = await call<AuditPage>(panel, "/api/events?tenant=globex", h);
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
  });

  test("a widened allow list still cannot write the global catalog or touch streams", async () => {
    const panel = await portalPanel({
      portal: {
        secret: SECRET,
        allow: ["action:read", "action:update", "stream:read", "event:erase"],
      },
      streams: [{ name: "s", sink: callbackSink(() => undefined) }],
      streamRunner: false,
    });
    const h = { headers: bearer(await createPortalToken(SECRET, "acme")) };
    expect((await call(panel, "/api/actions/x", { ...h, method: "PUT", body: {} })).status).toBe(
      403,
    );
    expect((await call(panel, "/api/streams", h)).status).toBe(403);
    const { body: page } = await call<AuditPage>(panel, "/api/events", {
      headers: bearer(await createPortalToken(SECRET, "acme")),
    });
    expect(page).toBeTruthy();
    await panel.close();
  });

  test("a view filter is AND-ed in; client params only narrow", async () => {
    const panel = await portalPanel();
    const token = await createPortalToken(SECRET, "acme", {
      filter: { excludeActions: ["support.*"] },
    });
    const h = { headers: bearer(token) };
    const all = await call<AuditPage>(panel, "/api/tenants/acme/events", h);
    expect(all.body.items.map((e) => e.action)).not.toContain("support.impersonate");
    expect(all.body.items).toHaveLength(3);
    // A client exclusion narrows further; a client include cannot re-add hidden actions.
    const narrower = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?excludeActions=user.login",
      h,
    );
    expect(narrower.body.items).toHaveLength(2);
    const sneaky = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?actions=support.impersonate",
      h,
    );
    expect(sneaky.body.items).toEqual([]);
  });

  test("an actor filter: a member sees only their own activity", async () => {
    const panel = await portalPanel();
    const token = await createPortalToken(SECRET, "acme", {
      filter: { actorId: "u1", actions: ["invoice.*", "user.login"] },
    });
    const h = { headers: bearer(token) };
    const mine = await call<AuditPage>(panel, "/api/tenants/acme/events", h);
    expect(mine.body.items.map((e) => e.actor.id)).toEqual(["u1", "u1"]);
    const intersected = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?actions=invoice.*",
      h,
    );
    expect(intersected.body.items.map((e) => e.action)).toEqual(["invoice.paid"]);
    const someoneElse = await call<AuditPage>(panel, "/api/tenants/acme/events?actorId=u2", h);
    expect(someoneElse.body.items).toEqual([]);

    // A single hidden event reads as 404; the tenant count is withheld.
    const hidden = (await panel.core.query({ tenant: "acme", actorId: "u2" })).items[0]!;
    expect((await call(panel, `/api/tenants/acme/events/${hidden.id}`, h)).status).toBe(404);
    const visible = mine.body.items[0]!;
    expect((await call(panel, `/api/tenants/acme/events/${visible.id}`, h)).status).toBe(200);
  });

  test("tenant detail hides the count for filtered tokens", async () => {
    const panel = await portalPanel({
      portal: { secret: SECRET, allow: ["tenant:read"] },
    });
    const plain = await call<{ count?: number }>(panel, "/api/tenants/acme", {
      headers: bearer(await createPortalToken(SECRET, "acme")),
    });
    expect(plain.body.count).toBe(4);
    const filtered = await call<{ count?: number }>(panel, "/api/tenants/acme", {
      headers: bearer(await createPortalToken(SECRET, "acme", { filter: { actorId: "u1" } })),
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body.count).toBeUndefined();
  });

  test("exports are filtered and self-audited with the portal principal as actor", async () => {
    const panel = await portalPanel();
    const token = await createPortalToken(SECRET, "acme", {
      filter: { excludeActions: ["support.*"] },
    });
    const res = await panel.fetch(
      new Request("http://panel.test/audit/api/tenants/acme/export?format=jsonl", {
        headers: bearer(token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="acme-audit-/);
    const actions = (await res.text())
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as AuditEvent).action);
    expect(actions).not.toContain("support.impersonate");
    const selfAudit = (await panel.core.query({ tenant: "acme", actions: ["audit_log.exported"] }))
      .items[0]!;
    expect(selfAudit.actor).toMatchObject({ id: "portal:acme", type: "portal" });

    // Outside the token's view → an empty export, not a widened one.
    const empty = await panel.fetch(
      new Request("http://panel.test/audit/api/tenants/acme/export?format=json&actions=support.*", {
        headers: bearer(token),
      }),
    );
    expect(await empty.json()).toEqual([]);
  });

  test("bundles: whole chain for unfiltered tokens, refused for filtered ones", async () => {
    const panel = await portalPanel();
    const plain = await panel.fetch(
      new Request("http://panel.test/audit/api/tenants/acme/export?format=bundle", {
        headers: bearer(await createPortalToken(SECRET, "acme")),
      }),
    );
    expect(plain.status).toBe(200);
    await plain.body?.cancel();
    const filtered = await call(panel, "/api/tenants/acme/export?format=bundle", {
      headers: bearer(await createPortalToken(SECRET, "acme", { filter: { actorId: "u1" } })),
    });
    expect(filtered.status).toBe(403);
  });

  test("bearer tokens without the audpt_ prefix go to the host's auth", async () => {
    const panel = makePanel({
      auth: delegatedAuth({
        authenticate: (r) =>
          r.headers.get("authorization") === "Bearer host-token" ? { id: "svc" } : null,
      }),
      portal: { secret: SECRET },
    });
    expect((await call(panel, "/api/tenants", { headers: bearer("host-token") })).status).toBe(200);
    expect((await call(panel, "/api/tenants", { headers: bearer("nope") })).status).toBe(401);
  });
});
