import { describe, expect, test } from "vitest";
import { Elysia } from "elysia";
import {
  auditContext as bunContext,
  auditPanel as bunPanel,
  withAuditContext,
} from "../src/adapters/bun.ts";
import {
  auditContext as elysiaContext,
  auditPanel as elysiaPanel,
} from "../src/adapters/elysia.ts";
import { auditContext as honoContext, auditPanel as honoPanel } from "../src/adapters/hono.ts";
import { createAuditCore } from "../src/core.ts";
import { getAuditContext } from "../src/context.ts";
import { callbackSink } from "../src/streams.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

describe("bun adapter", () => {
  test("returns a fetch handler with core, streams and openapi", async () => {
    const panel = bunPanel({ storage: createMemoryStorage() });
    expect(typeof panel.fetch).toBe("function");
    expect(panel.core).toBeDefined();
    expect(panel.streams).toBeNull(); // no streams declared
    expect(panel.openapi()).toMatchObject({ openapi: "3.1.0" });
    const res = await panel.fetch(new Request("http://x/config"));
    expect(res.status).toBe(200);
  });

  test("creates and starts a stream runner when streams are declared", async () => {
    const delivered: string[] = [];
    const panel = bunPanel({
      storage: createMemoryStorage(),
      streams: [
        {
          name: "siem",
          startFrom: "beginning",
          sink: callbackSink((b) => {
            for (const i of b.items) if (i.kind === "event") delivered.push(i.event.action);
          }),
        },
      ],
      streamRunner: { interval: 10 },
    });
    await panel.core.record({ tenant: "acme", action: "a.b", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(delivered).toEqual(["a.b"]);
    await panel.close();
  });

  test("withAuditContext opens a scope per request (socket IP fallback)", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const app = async (request: Request) => {
      const event = await audit.record({ action: "user.login" });
      return Response.json({ event, scope: getAuditContext(), url: request.url });
    };
    const fetch = withAuditContext(app, {
      actor: (r) => ({ id: r.headers.get("x-user") ?? "anon" }),
      tenant: () => "acme",
      context: () => ({ sessionId: "s1" }),
      trustProxy: false,
    });
    const server = { requestIP: () => ({ address: "10.0.0.9" }) };
    const res = await fetch(
      new Request("http://x/", {
        headers: {
          "x-user": "u7",
          "user-agent": "ua/1",
          "x-request-id": "rq",
          "x-forwarded-for": "6.6.6.6",
        },
      }),
      server,
    );
    const { event } = (await res.json()) as {
      event: { tenant: string; actor: { id: string }; context: Record<string, string> };
    };
    expect(event.tenant).toBe("acme");
    expect(event.actor.id).toBe("u7");
    expect(event.context).toEqual({
      ip: "10.0.0.9",
      userAgent: "ua/1",
      requestId: "rq",
      sessionId: "s1",
    });
    expect(getAuditContext()).toBeNull(); // nothing leaks out of the scope

    const curried = bunContext({ tenant: () => "globex" })(async () =>
      Response.json(getAuditContext()),
    );
    const scope = (await (await curried(new Request("http://x/"), {})).json()) as {
      tenant: string;
    };
    expect(scope.tenant).toBe("globex");
  });
});

describe("elysia adapter", () => {
  test("returns a request->response function with the extras attached", async () => {
    const handler = elysiaPanel({ storage: createMemoryStorage(), basePath: "/audit" });
    expect(typeof handler).toBe("function");
    expect(handler.core).toBeDefined();
    expect(handler.streams).toBeNull();
    expect(typeof handler.openapi).toBe("function");
    expect(typeof handler.close).toBe("function");
    const res = await handler(new Request("http://x/audit/config"));
    expect((await res.json()).basePath).toBe("/audit");
  });

  test("auditContext plugin scopes each request (concurrently isolated)", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const app = new Elysia()
      .derive(({ request }) => ({ user: { id: request.headers.get("x-user") ?? "anon" } }))
      .use(
        elysiaContext({
          actor: (ctx) => ctx.user as { id: string },
          tenant: (ctx) => ctx.request.headers.get("x-tenant"),
        }),
      )
      .get("/do", async () => {
        await new Promise((r) => setTimeout(r, 5));
        const event = await audit.record({ action: "thing.done" });
        return { tenant: event.tenant, actor: event.actor.id, ua: event.context.userAgent ?? null };
      });
    const results = await Promise.all(
      ["a", "b", "c"].map(async (t) =>
        (
          await app.handle(
            new Request("http://localhost/do", {
              headers: { "x-user": `u-${t}`, "x-tenant": `t-${t}`, "user-agent": `ua-${t}` },
            }),
          )
        ).json(),
      ),
    );
    expect(results).toEqual([
      { tenant: "t-a", actor: "u-a", ua: "ua-a" },
      { tenant: "t-b", actor: "u-b", ua: "ua-b" },
      { tenant: "t-c", actor: "u-c", ua: "ua-c" },
    ]);
  });
});

describe("hono adapter", () => {
  test("mounts under a route prefix", async () => {
    const { Hono } = await import("hono");
    const app = new Hono();
    app.route("/audit", honoPanel({ storage: createMemoryStorage(), basePath: "/audit" }));
    const res = await app.request("/audit/config");
    expect(res.status).toBe(200);
    expect((await res.json()).basePath).toBe("/audit");
  });

  test("serves the JSON API and streams exports through hono", async () => {
    const { Hono } = await import("hono");
    const app = new Hono();
    const panel = honoPanel({ storage: createMemoryStorage(), basePath: "/audit" });
    app.route("/audit", panel);
    const create = await app.request("/audit/api/tenants/acme/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "invoice.paid", actor: { id: "u1" } }),
    });
    expect(create.status).toBe(201);
    const list = await app.request("/audit/api/tenants");
    expect(((await list.json()) as { key: string }[]).map((t) => t.key)).toEqual(["acme"]);
    const exp = await app.request("/audit/api/tenants/acme/export?format=jsonl");
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    expect(exp.body).toBeInstanceOf(ReadableStream);
    expect((await exp.text()).trim().split("\n").length).toBeGreaterThan(0);
    // The same core is reachable on the sub-app for host-side record().
    expect(await panel.core.count("acme")).toBeGreaterThan(0);
    expect(panel.streams).toBeNull();
  });

  test("auditContext middleware scopes the downstream handlers", async () => {
    const { Hono } = await import("hono");
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const app = new Hono<{ Variables: { user: { id: string; org: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "u1", org: "acme" });
      await next();
    });
    app.use(
      "*",
      honoContext({
        actor: (c) => c.get("user") as { id: string },
        tenant: (c) => (c.get("user") as { org: string }).org,
      }),
    );
    app.post("/x", async (c) => {
      const event = await audit.record({ action: "thing.done" });
      return c.json({ tenant: event.tenant, actor: event.actor.id, ip: event.context.ip });
    });
    const res = await app.request("/x", {
      method: "POST",
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    expect(await res.json()).toEqual({ tenant: "acme", actor: "u1", ip: "1.2.3.4" });
  });
});
