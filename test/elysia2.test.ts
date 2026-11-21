// Runs in the `elysia2` vitest project: `elysia` → the elysia-v2 devDep alias
// (see vite.config.ts + tsconfig.elysia2.json). Elysia 2's Eden is `@elysia/eden`.
import { describe, expect, test } from "vitest";
import { Elysia, t } from "elysia";
import { treaty } from "@elysia/eden";
import { auditContext, auditElysia, auditPanel } from "../src/adapters/elysia2.ts";
import { createAuditCore } from "../src/core.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

const app = new Elysia().use(
  auditElysia({ prefix: "/audit", storage: createMemoryStorage(), title: "Eden v2" }),
);
const client = treaty<typeof app>(app);
const audit = client.audit!;
// Handlers delegate to a web Response, so Eden infers `data: Response`; cast via unknown.
const as = <T>(v: unknown): T => v as unknown as T;

describe("elysia 2 adapter", () => {
  test("runs against Elysia 2 (rejects the 1.x handler-then-hook order)", () => {
    const legacy = () =>
      // the 1.x order type-checks on v2, but Elysia 2 throws on it at registration
      new Elysia().post("/x", () => "x", { body: t.Object({ k: t.String() }) });
    expect(legacy).toThrow(/1\.x order/);
  });

  test("auditPanel mounts under a prefix", async () => {
    const panel = auditPanel({ storage: createMemoryStorage(), basePath: "/audit" });
    const mounted = new Elysia().mount("/audit", panel);
    const res = await mounted.handle(new Request("http://localhost/audit/config"));
    expect((await res.json()).basePath).toBe("/audit");
    expect(panel.streams).toBeNull();
  });

  test("reads bootstrap config via client.audit.config", async () => {
    const { data, error } = await audit.config.get();
    expect(error).toBeNull();
    expect(as<{ title: string }>(data).title).toBe("Eden v2");
  });

  test("records, lists and verifies through the typed path", async () => {
    const acme = audit.api.tenants({ tenant: "acme" });
    const created = await acme.events.post({ action: "invoice.paid", actor: { id: "u1" } });
    expect(created.response.status).toBe(201);
    const list = await acme.events.get();
    expect(as<{ items: unknown[] }>(list.data).items).toHaveLength(1);
    const verify = await acme.verify.get();
    expect(as<{ ok: boolean }>(verify.data).ok).toBe(true);
    const put = await audit.api.actions({ name: "invoice.paid" }).put({ description: "Paid" });
    expect(as<{ description: string }>(put.data).description).toBe("Paid");
  });

  test("validates declared bodies", async () => {
    const res = await app.handle(
      new Request("http://localhost/audit/api/tenants/acme/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ missing: "action" }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("serves the bundled UI catch-all", async () => {
    const res = await app.handle(new Request("http://localhost/audit/"));
    expect(res.status).toBeLessThan(500);
  });

  test("auditContext scopes each request", async () => {
    const core = createAuditCore({ storage: createMemoryStorage() });
    const host = new Elysia()
      .use(
        auditContext({
          actor: (ctx) => ({ id: ctx.request.headers.get("x-user") ?? "anon" }),
          tenant: () => "acme",
        }),
      )
      .get("/do", async () => {
        await new Promise((r) => setTimeout(r, 5));
        const event = await core.record({ action: "thing.done" });
        return { tenant: event.tenant, actor: event.actor.id };
      });
    const results = await Promise.all(
      ["a", "b"].map(async (u) =>
        (
          await host.handle(new Request("http://localhost/do", { headers: { "x-user": u } }))
        ).json(),
      ),
    );
    expect(results).toEqual([
      { tenant: "acme", actor: "a" },
      { tenant: "acme", actor: "b" },
    ]);
  });
});
