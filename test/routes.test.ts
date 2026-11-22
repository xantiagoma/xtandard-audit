import { describe, expect, test } from "vitest";
import { HookDeniedError } from "../src/hooks/contract.ts";
import { ed25519Signer, generateSigningKeyPair, hmacSigner } from "../src/integrity.ts";
import { verifyBundle } from "../src/export.ts";
import type { AuditCheckpoint, AuditEvent, AuditPage, ActionDefinition } from "../src/schema.ts";
import { callbackSink, type StreamBatch, type StreamStatus } from "../src/streams.ts";
import { defineActions } from "../src/standard-schema.ts";
import { exportFilename, parseQueryParams } from "../src/server/routes.ts";
import { createFetchHandler } from "../src/server/create-fetch-handler.ts";
import { call, evt, makePanel } from "./panel-fixtures.ts";

async function seeded(options: Parameters<typeof makePanel>[0] = {}) {
  const panel = makePanel(options);
  await call(panel, "/api/tenants/acme/events", {
    body: [
      evt("invoice.paid", { targets: [{ type: "invoice", id: "inv_1" }], metadata: { amount: 1 } }),
      evt("invoice.refunded", { actor: { id: "u2", type: "support" }, outcome: "failure" }),
      evt("user.login"),
    ],
  });
  await call(panel, "/api/tenants/globex/events", { body: evt("user.login") });
  return panel;
}

describe("meta routes", () => {
  test("/config describes the principal, allowed actions and features", async () => {
    const panel = makePanel({ title: "Acme Audit", logoUrl: "/logo.svg" });
    const { status, body } = await call<Record<string, unknown>>(panel, "/config");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      title: "Acme Audit",
      basePath: "/audit",
      readonly: false,
      logoUrl: "/logo.svg",
      portal: false,
      principal: { id: "anonymous" },
      features: { signer: false, streams: false },
    });
    expect(body.allowed).toContain("event:erase");
    expect((await call(panel, "/api/config")).status).toBe(200);
  });

  test("/config drops mutating actions when readonly", async () => {
    const { body } = await call<{ allowed: string[] }>(makePanel({ readonly: true }), "/config");
    expect(body.allowed).toContain("event:read");
    expect(body.allowed).not.toContain("event:record");
  });

  test("serves the OpenAPI document publicly", async () => {
    const panel = makePanel();
    const { body } = await call<{ openapi: string; paths: Record<string, unknown> }>(
      panel,
      "/api/openapi.json",
    );
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths)).toContain("/api/tenants/{tenant}/export");
    expect(panel.openapi()).toEqual(body);
    expect((await call(panel, "/openapi.json")).status).toBe(200);
  });

  test("serves the public JWKS with open CORS", async () => {
    const { privateJwk } = await generateSigningKeyPair();
    const panel = makePanel({ signer: await ed25519Signer(privateJwk) });
    const { body, res } = await call<{ keys: JsonWebKey[] }>(panel, "/api/integrity/keys");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(body.keys[0]).not.toHaveProperty("d");
    const { body: config } = await call<{ features: { signer: boolean } }>(panel, "/config");
    expect(config.features.signer).toBe(true);
  });
});

describe("tenants and events", () => {
  test("overview, tenant list and tenant detail", async () => {
    const panel = await seeded();
    const { body: overview } = await call<{
      tenants: number;
      events: number;
      recent: AuditEvent[];
      streams: unknown[];
    }>(panel, "/api/overview");
    expect(overview.tenants).toBe(2);
    expect(overview.events).toBe(4);
    expect(overview.recent).toHaveLength(4);
    expect(overview.streams).toEqual([]);

    const { body: tenants } = await call<{ key: string }[]>(panel, "/api/tenants");
    expect(tenants.map((t) => t.key)).toEqual(["acme", "globex"]);

    const { body: acme } = await call<{ key: string; count: number; head: { seq: number } }>(
      panel,
      "/api/tenants/acme",
    );
    expect(acme).toMatchObject({ key: "acme", count: 3, head: { seq: 3 } });
    expect((await call(panel, "/api/tenants/nobody")).status).toBe(404);
  });

  test("records one event (201) and defaults the actor to the principal", async () => {
    const panel = makePanel();
    const { status, body } = await call<AuditEvent>(panel, "/api/tenants/acme/events", {
      body: { action: "deploy.finished" },
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ tenant: "acme", seq: 1, actor: { id: "anonymous", type: "api" } });
  });

  test("rejects a body tenant that differs from the path (422)", async () => {
    const panel = makePanel();
    const one = await call<{ errors: { path: string }[] }>(panel, "/api/tenants/acme/events", {
      body: { ...evt("a.b"), tenant: "globex" },
    });
    expect(one.status).toBe(422);
    expect(one.body.errors[0]!.path).toBe("event.tenant");
    const many = await call<{ errors: { path: string }[] }>(panel, "/api/tenants/acme/events", {
      body: [evt("a.b"), 5],
    });
    expect(many.status).toBe(422);
    expect(many.body.errors[0]!.path).toBe("[1]");
  });

  test("maps validation errors to 422 and bad JSON to 400", async () => {
    const panel = makePanel();
    const bad = await call<{ code: string }>(panel, "/api/tenants/acme/events", {
      body: { action: "has space", actor: { id: "u" } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("VALIDATION");
    const broken = await call(panel, "/api/tenants/acme/events", { body: "{nope" });
    expect(broken.status).toBe(400);
  });

  test("an explicit id re-recorded with different content is a 409", async () => {
    const panel = makePanel();
    await call(panel, "/api/tenants/acme/events", { body: evt("a.b", { id: "evt_fixed" }) });
    const again = await call(panel, "/api/tenants/acme/events", {
      body: evt("a.c", { id: "evt_fixed" }),
    });
    expect(again.status).toBe(409);
  });

  test("lists, filters and paginates a tenant's events", async () => {
    const panel = await seeded();
    const all = await call<AuditPage>(panel, "/api/tenants/acme/events");
    expect(all.body.items).toHaveLength(3);

    const family = await call<AuditPage>(panel, "/api/tenants/acme/events?actions=invoice.*");
    expect(family.body.items.map((e) => e.action).sort()).toEqual([
      "invoice.paid",
      "invoice.refunded",
    ]);
    const repeated = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?actions=invoice.paid&actions=user.login",
    );
    expect(repeated.body.items).toHaveLength(2);
    const comma = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?excludeActions=invoice.paid,user.login",
    );
    expect(comma.body.items.map((e) => e.action)).toEqual(["invoice.refunded"]);
    const filtered = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?actorId=u2&actorType=support&outcome=failure",
    );
    expect(filtered.body.items).toHaveLength(1);
    const target = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?targetType=invoice&targetId=inv_1&search=inv_1",
    );
    expect(target.body.items).toHaveLength(1);

    const page1 = await call<AuditPage>(panel, "/api/tenants/acme/events?limit=2&order=asc");
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.pageInfo.hasNextPage).toBe(true);
    const page2 = await call<AuditPage>(
      panel,
      `/api/tenants/acme/events?limit=2&order=asc&cursor=${page1.body.pageInfo.endCursor}`,
    );
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });

  test("the path tenant wins over a tenant= parameter", async () => {
    const panel = await seeded();
    const { body } = await call<AuditPage>(panel, "/api/tenants/acme/events?tenant=globex");
    expect(body.items.every((e) => e.tenant === "acme")).toBe(true);
  });

  test("searches across tenants, or one with tenant=", async () => {
    const panel = await seeded();
    const all = await call<AuditPage>(panel, "/api/events?actions=user.login");
    expect(all.body.items.map((e) => e.tenant).sort()).toEqual(["acme", "globex"]);
    const one = await call<AuditPage>(panel, "/api/events?tenant=globex");
    expect(one.body.items.map((e) => e.tenant)).toEqual(["globex"]);
  });

  test.each([
    ["cursor", "cursor=not-a-cursor"],
    ["limit", "limit=0"],
    ["limit (too big)", "limit=501"],
    ["limit (not a number)", "limit=abc"],
    ["outcome", "outcome=maybe"],
    ["order", "order=up"],
    ["from", "from=yesterday"],
  ])("rejects a bad %s with 400", async (_label, qs) => {
    const { status, body } = await call<{ code: string }>(makePanel(), `/api/events?${qs}`);
    expect(status).toBe(400);
    expect(body.code).toBe("BAD_QUERY");
  });

  test("gets one event, 404 otherwise", async () => {
    const panel = await seeded();
    const { body: page } = await call<AuditPage>(panel, "/api/tenants/acme/events?limit=1");
    const id = page.items[0]!.id;
    const one = await call<AuditEvent>(panel, `/api/tenants/acme/events/${id}`);
    expect(one.body.id).toBe(id);
    expect((await call(panel, `/api/tenants/globex/events/${id}`)).status).toBe(404);
    expect((await call(panel, "/api/tenants/acme/events/evt_missing")).status).toBe(404);
  });

  test("erases sections (body optional) and self-audits", async () => {
    const panel = await seeded();
    const { body: page } = await call<AuditPage>(panel, "/api/tenants/acme/events?limit=1");
    const id = page.items[0]!.id;
    const partial = await call<AuditEvent>(panel, `/api/tenants/acme/events/${id}/erase`, {
      body: { sections: ["metadata"], reason: "GDPR" },
    });
    expect(partial.status).toBe(200);
    expect(partial.body.integrity.erased).toEqual(["metadata"]);
    const full = await call<AuditEvent>(panel, `/api/tenants/acme/events/${id}/erase`, {
      method: "POST",
    });
    expect(full.body.integrity.erased).toHaveLength(5);
    const audit = await call<AuditPage>(panel, "/api/tenants/acme/events?actions=audit_log.erased");
    expect(audit.body.items).toHaveLength(2);
    expect(audit.body.items[0]!.actor).toMatchObject({ id: "anonymous" });
    const unknown = await call(panel, `/api/tenants/acme/events/${id}/erase`, {
      body: { sections: ["nope"] },
    });
    expect(unknown.status).toBe(422);
    expect(
      (await call(panel, "/api/tenants/acme/events/evt_missing/erase", { method: "POST" })).status,
    ).toBe(404);
  });
});

describe("export", () => {
  test("streams CSV as an attachment and self-audits the export", async () => {
    const panel = await seeded();
    const res = await panel.fetch(
      new Request("http://panel.test/audit/api/tenants/acme/export?format=csv&actions=invoice.*"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="acme-audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(3); // header + two invoice events
    const exported = await call<AuditPage>(
      panel,
      "/api/tenants/acme/events?actions=audit_log.exported",
    );
    expect(exported.body.items).toHaveLength(1);
    expect(exported.body.items[0]!.metadata).toMatchObject({ format: "csv" });
  });

  test("defaults to csv; json and jsonl stream events", async () => {
    const panel = await seeded();
    const csv = await panel.fetch(new Request("http://panel.test/audit/api/tenants/acme/export"));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    await csv.body?.cancel();
    const json = await panel.fetch(
      new Request("http://panel.test/audit/api/tenants/globex/export?format=json"),
    );
    // The export notes itself (self-audit) before streaming, so it is part of it.
    expect(((await json.json()) as AuditEvent[]).map((e) => e.action).sort()).toEqual([
      "audit_log.exported",
      "user.login",
    ]);
    const jsonl = await panel.fetch(
      new Request("http://panel.test/audit/api/tenants/globex/export?format=jsonl"),
    );
    expect(jsonl.headers.get("content-disposition")).toContain(".jsonl");
    expect((await jsonl.text()).trim().split("\n")).toHaveLength(3);
  });

  test("a bundle verifies offline", async () => {
    const panel = await seeded({ signer: hmacSigner("s") });
    await call(panel, "/api/tenants/acme/checkpoints", { method: "POST" });
    const res = await panel.fetch(
      new Request("http://panel.test/audit/api/tenants/acme/export?format=bundle"),
    );
    expect(res.headers.get("content-disposition")).toContain(".bundle.jsonl");
    const report = await verifyBundle(await res.text());
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(4); // three events + the export's own self-audit
  });

  test("rejects an unknown format", async () => {
    const { status } = await call(makePanel(), "/api/tenants/acme/export?format=xml");
    expect(status).toBe(400);
  });

  test("a before hook can deny an export with its status", async () => {
    const panel = await seeded({
      hooks: {
        before(event) {
          if (event.type === "events.export")
            throw new HookDeniedError("No exports", { status: 402 });
        },
      },
    });
    const { status, body } = await call<{ code: string }>(panel, "/api/tenants/acme/export");
    expect(status).toBe(402);
    expect(body.code).toBe("HOOK_DENIED");
  });
});

describe("integrity", () => {
  test("verifies a chain (whole, or a range)", async () => {
    const panel = await seeded();
    const { body } = await call<{ ok: boolean; checked: number; anchor: string }>(
      panel,
      "/api/tenants/acme/verify",
    );
    expect(body).toMatchObject({ ok: true, checked: 3, anchor: "genesis" });
    const range = await call<{ checked: number }>(
      panel,
      "/api/tenants/acme/verify?fromSeq=2&toSeq=3",
    );
    expect(range.body.checked).toBe(2);
    expect((await call(panel, "/api/tenants/acme/verify?fromSeq=x")).status).toBe(400);
  });

  test("creates (201) and lists checkpoints", async () => {
    const panel = await seeded({ signer: hmacSigner("s") });
    const created = await call<AuditCheckpoint>(panel, "/api/tenants/acme/checkpoints", {
      method: "POST",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ tenant: "acme", kind: "head", seq: 3, alg: "HS256" });
    const list = await call<AuditCheckpoint[]>(panel, "/api/tenants/acme/checkpoints");
    expect(list.body.map((c) => c.id)).toContain(created.body.id);
  });

  test("checkpointing without a signer is a 409", async () => {
    const { status, body } = await call<{ code: string }>(
      await seeded(),
      "/api/tenants/acme/checkpoints",
      { method: "POST" },
    );
    expect(status).toBe(409);
    expect(body.code).toBe("SIGNER_REQUIRED");
  });
});

describe("retention", () => {
  test("prunes one tenant or all", async () => {
    const panel = await seeded({ retention: { keepLast: 1 } });
    const one = await call<{ tenant: string; pruned: number }>(panel, "/api/tenants/acme/prune", {
      method: "POST",
    });
    expect(one.body).toMatchObject({ tenant: "acme", pruned: 2 });
    const all = await call<{ tenant: string }[]>(panel, "/api/prune", { method: "POST" });
    expect(all.body.map((r) => r.tenant)).toEqual(["acme", "globex"]);
  });
});

describe("action catalog", () => {
  test("upserts, lists and deletes UI actions", async () => {
    const panel = makePanel();
    const put = await call<ActionDefinition>(panel, "/api/actions/invoice.paid", {
      method: "PUT",
      body: { description: "An invoice was paid", group: "Billing", name: "ignored" },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ name: "invoice.paid", source: "ui", group: "Billing" });
    const list = await call<ActionDefinition[]>(panel, "/api/actions");
    expect(list.body.map((a) => a.name)).toEqual(["invoice.paid"]);
    const del = await call(panel, "/api/actions/invoice.paid", { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await call(panel, "/api/actions/invoice.paid", { method: "DELETE" })).status).toBe(404);
    const bad = await call(panel, "/api/actions/x", { method: "PUT", body: [1] });
    expect(bad.status).toBe(422);
  });

  test("code-defined actions cannot be deleted (409)", async () => {
    const panel = makePanel({ actions: defineActions({ "invoice.paid": {} }) });
    const { status } = await call(panel, "/api/actions/invoice.paid", { method: "DELETE" });
    expect(status).toBe(409);
  });
});

describe("streams", () => {
  test("status and retry", async () => {
    const batches: StreamBatch[] = [];
    let fail = true;
    const panel = makePanel({
      streams: [
        {
          name: "siem",
          startFrom: "beginning",
          sink: callbackSink((b) => {
            if (fail) throw new Error("down");
            batches.push(b);
          }),
        },
      ],
      streamRunner: false,
    });
    expect(panel.streams).not.toBeNull();
    await call(panel, "/api/tenants/acme/events", { body: evt("a.b") });
    await panel.streams!.tick();
    const { body: status } = await call<StreamStatus[]>(panel, "/api/streams");
    expect(status[0]).toMatchObject({ name: "siem", kind: "callback" });
    expect(status[0]!.tenants[0]).toMatchObject({ tenant: "acme", failures: 1, lastError: "down" });
    expect(status[0]!.tenants[0]!.nextAttemptAt).toBeDefined();

    fail = false;
    const retry = await call(panel, "/api/streams/siem/retry?tenant=acme", { method: "POST" });
    expect(retry.status).toBe(204);
    await panel.streams!.tick();
    expect(batches).toHaveLength(1);
    expect((await call(panel, "/api/streams/nope/retry", { method: "POST" })).status).toBe(404);
    const { body: config } = await call<{ features: { streams: boolean } }>(panel, "/config");
    expect(config.features.streams).toBe(true);
    await panel.close();
  });

  test("without streams: empty status, retry 404", async () => {
    const panel = makePanel();
    expect(panel.streams).toBeNull();
    expect((await call(panel, "/api/streams")).body).toEqual([]);
    expect((await call(panel, "/api/streams/x/retry", { method: "POST" })).status).toBe(404);
  });
});

describe("readonly", () => {
  test("mutating routes answer 423; reads still work", async () => {
    const panel = makePanel({ readonly: true });
    for (const [path, method] of [
      ["/api/tenants/acme/events", "POST"],
      ["/api/tenants/acme/events/evt_x/erase", "POST"],
      ["/api/tenants/acme/checkpoints", "POST"],
      ["/api/tenants/acme/prune", "POST"],
      ["/api/prune", "POST"],
      ["/api/actions/x", "PUT"],
      ["/api/actions/x", "DELETE"],
      ["/api/streams/x/retry", "POST"],
    ] as const) {
      const { status, body } = await call<{ code: string }>(panel, path, {
        method,
        ...(method !== "DELETE" ? { body: {} } : {}),
      });
      expect(status, `${method} ${path}`).toBe(423);
      expect(body.code).toBe("READONLY");
    }
    expect((await call(panel, "/api/tenants")).status).toBe(200);
  });

  test("a readonly core error (ReadonlyError) also maps to 423", async () => {
    const { createAuditCore } = await import("../src/core.ts");
    const { createMemoryStorage } = await import("../src/storage/memory.ts");
    const core = createAuditCore({ storage: createMemoryStorage(), readonly: true });
    const panel = makePanel({ core });
    const { status } = await call(panel, "/api/actions/x", { method: "PUT", body: {} });
    expect(status).toBe(423);
  });
});

describe("routing and SPA", () => {
  test("unknown API routes 404; non-GET non-API 405", async () => {
    const panel = makePanel();
    expect((await call(panel, "/api/nope")).status).toBe(404);
    expect((await call(panel, "/api/tenants", { method: "DELETE" })).status).toBe(404);
    expect((await call(panel, "/somewhere", { method: "POST", body: {} })).status).toBe(405);
  });

  test("SPA fallback injects the bootstrap config; missing assets 404", async () => {
    const panel = makePanel({ uiDir: "/nonexistent-ui-dir", title: "T<x>" });
    const res = await panel.fetch(new Request("http://panel.test/audit/tenants/acme"));
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<base href="/audit/">');
    expect(html).toContain("window.__AUDIT_CONFIG__=");
    expect(html).toContain("\\u003cx\\u003e");
    expect((await call(panel, "/assets/app.js")).status).toBe(404);
  });

  test("requires storage or core", async () => {
    const { createFetchHandler } = await import("../src/server/create-fetch-handler.ts");
    expect(() => createFetchHandler({})).toThrow(/storage/);
  });
});

describe("helpers", () => {
  test("parseQueryParams reads the documented parameters", () => {
    const q = parseQueryParams(
      new URLSearchParams(
        "actions=a,b&actions=c&excludeActions=d&tenant=t&actorId=u&actorType=x&targetType=y&targetId=z&outcome=success&from=2026-01-01&to=2026-02-01&search=s&order=asc&limit=10&cursor=c",
      ),
    );
    expect(q).toEqual({
      actions: ["a", "b", "c"],
      excludeActions: ["d"],
      tenant: "t",
      actorId: "u",
      actorType: "x",
      targetType: "y",
      targetId: "z",
      outcome: "success",
      from: "2026-01-01",
      to: "2026-02-01",
      search: "s",
      order: "asc",
      limit: 10,
      cursor: "c",
    });
  });

  test("exportFilename sanitizes the tenant", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(exportFilename("org:acme/1", "bundle", now)).toBe(
      "org_acme_1-audit-2026-11-20.bundle.jsonl",
    );
  });
});

describe("maintenance", () => {
  test("prunes on a timer when retention is configured", async () => {
    const panel = makePanel({ retention: { keepLast: 1 }, maintenance: { interval: 20 } });
    await call(panel, "/api/tenants/acme/events", { body: [evt("a.b"), evt("a.c"), evt("a.d")] });
    await new Promise((r) => setTimeout(r, 120));
    expect(await panel.core.count("acme")).toBeLessThan(3);
    await panel.close();
  });
});

describe("routes — key-shaped path params (inventory §5, MySQL PAD SPACE)", () => {
  test("a padded or impossible tenant / event id is a 404, never a storage lookup", async () => {
    const panel = await seeded();
    const [event] = (await call<AuditPage>(panel, "/api/tenants/acme/events?limit=1")).body.items;
    for (const path of [
      "/api/tenants/acme%20",
      "/api/tenants/acme%20/events",
      `/api/tenants/acme%20/events/${event!.id}`,
      `/api/tenants/acme/events/${event!.id}%20`,
      "/api/tenants/acme%20/export",
      "/api/tenants/acme%20/verify",
      "/api/tenants/..",
    ]) {
      expect((await call(panel, path)).status, path).toBe(404);
    }
    const erase = await call(panel, `/api/tenants/acme/events/${event!.id}%20/erase`, {
      method: "POST",
    });
    expect(erase.status).toBe(404);
    expect((await call(panel, "/api/events?tenant=acme%20")).status).toBe(400);
    // Recording keeps the core's own validation error.
    const record = await call(panel, "/api/tenants/acme%20/events", { body: evt("x.y") });
    expect(record.status).toBe(422);
  });

  test("a malformed % escape is a 404, not a 500", async () => {
    expect((await call(makePanel(), "/api/tenants/%E0%A4%A")).status).toBe(404);
  });
});

describe("panel (from @xtandard/kit/server)", () => {
  test("serves /healthcheck inside the panel", async () => {
    const { status, body } = await call(makePanel(), "/healthcheck");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  test("the SPA gets window.__AUDIT_CONFIG__, an escaped title and no-cache", async () => {
    const { res, body } = await call<string>(
      makePanel({ title: "<script>x</script>", uiDir: "/nonexistent" }),
      "/events",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(body).toContain("window.__AUDIT_CONFIG__=");
    expect(body).toContain('<base href="/audit/">');
    expect(body).not.toContain("<script>x</script>");
  });

  test("a non-GET on a non-API path is 405 with Allow", async () => {
    const { status, res } = await call(makePanel(), "/somewhere", { method: "POST" });
    expect(status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  test("answers CORS preflights and decorates responses when configured", async () => {
    const panel = makePanel({ cors: { origin: "https://app.example.com", credentials: true } });
    const origin = { origin: "https://app.example.com" };
    const pre = await call(panel, "/api/tenants", { method: "OPTIONS", headers: origin });
    expect(pre.status).toBe(204);
    expect(pre.res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    const res = await call(panel, "/api/tenants", { headers: origin });
    expect(res.res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("requires storage or a prebuilt core", () => {
    expect(() => createFetchHandler({})).toThrow(/requires either `storage` or `core`/);
  });
});
