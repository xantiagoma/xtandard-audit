import { describe, expect, test } from "vitest";
import { Elysia } from "elysia";
import { treaty } from "@elysiajs/eden";
import { auditElysia } from "../src/adapters/elysia.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

// Mounting the typed plugin under /audit gives Eden's treaty a typed surface:
// client.audit.api.tenants({ tenant: "acme" }).events.get(), etc.
const app = new Elysia().use(
  auditElysia({ prefix: "/audit", storage: createMemoryStorage(), title: "Eden Test" }),
);
const client = treaty<typeof app>(app);
// Eden types the prefix group as optional; bind it once for ergonomic access.
const audit = client.audit!;
// Handlers delegate to a web Response, so Eden infers `data: Response`; cast via unknown.
const as = <T>(v: unknown): T => v as unknown as T;

describe("eden typed client", () => {
  test("reads bootstrap config via client.audit.config", async () => {
    const { data, error } = await audit.config.get();
    expect(error).toBeNull();
    expect(as<{ basePath: string }>(data).basePath).toBe("/audit");
    expect(as<{ title: string }>(data).title).toBe("Eden Test");
  });

  test("records (one and many) and lists events through the typed path", async () => {
    const one = await audit.api
      .tenants({ tenant: "acme" })
      .events.post({ action: "invoice.paid", actor: { id: "u1" }, metadata: { amount: 1 } });
    expect(one.response.status).toBe(201);
    const many = await audit.api.tenants({ tenant: "acme" }).events.post([
      { action: "user.login", actor: { id: "u1" } },
      { action: "user.logout", actor: { id: "u1" } },
    ]);
    expect(as<unknown[]>(many.data)).toHaveLength(2);

    const list = await audit.api.tenants({ tenant: "acme" }).events.get({
      query: { actions: "user.*" },
    });
    expect(as<{ items: unknown[] }>(list.data).items).toHaveLength(2);

    const tenants = await audit.api.tenants.get();
    expect(as<{ key: string }[]>(tenants.data).map((t) => t.key)).toEqual(["acme"]);
    const id = as<{ id: string }>(one.data).id;
    const got = await audit.api.tenants({ tenant: "acme" }).events({ id }).get();
    expect(as<{ id: string }>(got.data).id).toBe(id);
  });

  test("erases with and without a body", async () => {
    const created = await audit.api
      .tenants({ tenant: "erase" })
      .events.post({ action: "a.b", actor: { id: "u1" } });
    const id = as<{ id: string }>(created.data).id;
    const partial = await audit.api
      .tenants({ tenant: "erase" })
      .events({ id })
      .erase.post({ sections: ["metadata"], reason: "test" });
    expect(as<{ integrity: { erased: string[] } }>(partial.data).integrity.erased).toEqual([
      "metadata",
    ]);
    const res = await app.handle(
      new Request(`http://localhost/audit/api/tenants/erase/events/${id}/erase`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
  });

  test("verifies, prunes, manages the catalog and reads streams", async () => {
    const verify = await audit.api.tenants({ tenant: "acme" }).verify.get();
    expect(as<{ ok: boolean }>(verify.data).ok).toBe(true);
    const cp = await audit.api.tenants({ tenant: "acme" }).checkpoints.post();
    expect(cp.response.status).toBe(409); // no signer configured
    const prune = await audit.api.prune.post();
    expect(prune.response.status).toBe(200);
    const put = await audit.api.actions({ name: "invoice.paid" }).put({ group: "Billing" });
    expect(as<{ group: string }>(put.data).group).toBe("Billing");
    const del = await audit.api.actions({ name: "invoice.paid" }).delete();
    expect(del.response.status).toBe(204);
    const streams = await audit.api.streams.get();
    expect(as<unknown[]>(streams.data)).toEqual([]);
  });

  test("exports stream through the declared route", async () => {
    const res = await app.handle(
      new Request("http://localhost/audit/api/tenants/acme/export?format=jsonl"),
    );
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect((await res.text()).trim().split("\n").length).toBeGreaterThanOrEqual(3);
  });

  test("exposes the OpenAPI document and the JWKS", async () => {
    const res = await audit.api["openapi.json"].get();
    expect(as<{ openapi: string }>(res.data).openapi).toBe("3.1.0");
    const keys = await audit.api.integrity.keys.get();
    expect(as<{ keys: unknown[] }>(keys.data).keys).toEqual([]);
  });

  test("the catch-all serves the SPA fallback", async () => {
    const res = await app.handle(new Request("http://localhost/audit/tenants/acme"));
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
