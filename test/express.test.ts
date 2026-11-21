import { afterAll, beforeAll, describe, expect, test } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { auditContext, auditPanel } from "../src/adapters/express.ts";
import { createAuditCore } from "../src/core.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

let server: Server;
let base: string;
const audit = createAuditCore({ storage: createMemoryStorage() });
const panel = auditPanel({ basePath: "/audit", storage: createMemoryStorage() });

beforeAll(async () => {
  const app = express();
  app.get("/", (_req, res) => res.send("app"));
  app.use("/audit", panel);
  // A mount where an upstream body parser consumes the stream first, so the
  // adapter must re-serialize req.body (the `req.readableEnded` branch).
  app.use(
    "/parsed",
    express.json(),
    auditPanel({ basePath: "/parsed", storage: createMemoryStorage() }),
  );
  // The request-context middleware around a host route.
  app.use(
    "/host",
    (req, _res, next) => {
      (req as unknown as { user: { id: string; org: string } }).user = {
        id: String(req.headers["x-user"] ?? "anon"),
        org: "acme",
      };
      next();
    },
    auditContext({
      actor: (req) => (req as unknown as { user: { id: string } }).user,
      tenant: (req) => (req as unknown as { user: { org: string } }).user.org,
      trustProxy: false,
    }),
  );
  app.post("/host/do", async (_req, res) => {
    const event = await audit.record({ action: "thing.done" });
    res.json({ tenant: event.tenant, actor: event.actor.id, context: event.context });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://localhost:${port}`;
});

afterAll(() => {
  server?.close();
});

describe("express adapter", () => {
  test("serves bootstrap config under the mount path", async () => {
    const res = await fetch(`${base}/audit/config`);
    expect(res.status).toBe(200);
    expect((await res.json()).basePath).toBe("/audit");
  });

  test("does not interfere with the host app", async () => {
    const res = await fetch(`${base}/`);
    expect(await res.text()).toBe("app");
  });

  test("handles a POST with a JSON body (raw stream)", async () => {
    const res = await fetch(`${base}/audit/api/tenants/acme/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "invoice.paid", actor: { id: "u1" } }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).seq).toBe(1);
    expect(await panel.core.count("acme")).toBe(1);
  });

  test("handles a POST after an upstream body parser consumed the stream", async () => {
    const res = await fetch(`${base}/parsed/api/tenants/acme/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { action: "a.b", actor: { id: "u1" } },
        { action: "a.c", actor: { id: "u1" } },
      ]),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as unknown[]).length).toBe(2);
  });

  test("streams exports with their headers", async () => {
    const tenant = `big-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 50; i++) {
      await panel.core.record({ tenant, action: "x.y", actor: { id: `u${i}` } });
    }
    const res = await fetch(`${base}/audit/api/tenants/${tenant}/export?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`filename="${tenant}-audit-`);
    // header + 50 events + the export's own self-audit row
    expect((await res.text()).trim().split("\n")).toHaveLength(52);
  });

  test("204 responses have no body", async () => {
    await fetch(`${base}/audit/api/actions/x.y`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "X" }),
    });
    const res = await fetch(`${base}/audit/api/actions/x.y`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("exposes core, streams, openapi and close on the middleware", () => {
    expect(panel.core).toBeDefined();
    expect(panel.streams).toBeNull();
    expect(panel.openapi()).toMatchObject({ openapi: "3.1.0" });
    expect(typeof panel.close).toBe("function");
  });

  test("auditContext attributes host events (socket IP when proxies are untrusted)", async () => {
    const res = await fetch(`${base}/host/do`, {
      method: "POST",
      headers: { "x-user": "u42", "x-forwarded-for": "6.6.6.6", "x-request-id": "rq-1" },
    });
    const body = (await res.json()) as {
      tenant: string;
      actor: string;
      context: { ip?: string; requestId?: string };
    };
    expect(body.tenant).toBe("acme");
    expect(body.actor).toBe("u42");
    expect(body.context.requestId).toBe("rq-1");
    expect(body.context.ip).not.toBe("6.6.6.6");
    expect(body.context.ip).toMatch(/127\.0\.0\.1|::1/);
  });
});
