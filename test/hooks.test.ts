import { describe, expect, test } from "vitest";
import { HookDeniedError, type AfterEvent, type BeforeEvent } from "../src/hooks/contract.ts";
import { hmacSigner } from "../src/integrity.ts";
import { call, evt, makePanel } from "./panel-fixtures.ts";

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("hooks through the panel", () => {
  test("before hooks see every control-plane mutation, with the principal as actor", async () => {
    const before: BeforeEvent[] = [];
    const after: AfterEvent[] = [];
    const panel = makePanel({
      signer: hmacSigner("s"),
      retention: { keepLast: 1 },
      hooks: { before: (e) => void before.push(e), after: (e) => void after.push(e) },
    });
    const { body } = await call<{ id: string }>(panel, "/api/tenants/acme/events", {
      body: evt("a.b"),
    });
    await call(panel, "/api/tenants/acme/events", { body: evt("a.c") });
    await call(panel, `/api/tenants/acme/events/${body.id}/erase`, {
      body: { sections: ["metadata"] },
    });
    await call(panel, "/api/tenants/acme/checkpoints", { method: "POST" });
    const exp = await panel.fetch(new Request("http://panel.test/audit/api/tenants/acme/export"));
    await exp.text();
    await call(panel, "/api/tenants/acme/prune", { method: "POST" });
    await call(panel, "/api/actions/x.y", { method: "PUT", body: { description: "X" } });
    await call(panel, "/api/actions/x.y", { method: "DELETE" });
    await flush();

    expect(new Set(before.map((e) => e.type))).toEqual(
      new Set([
        "event.record",
        "event.erase",
        "checkpoint.create",
        "events.export",
        "events.prune",
        "action.upsert",
        "action.delete",
      ]),
    );
    const erase = before.find((e) => e.type === "event.erase") as Extract<
      BeforeEvent,
      { type: "event.erase" }
    >;
    expect(erase.actor).toEqual({ id: "anonymous" });
    expect(new Set(after.map((e) => e.type))).toEqual(
      new Set([
        "events.recorded",
        "event.erased",
        "checkpoint.created",
        "events.exported",
        "events.pruned",
        "action.upserted",
        "action.deleted",
      ]),
    );
  });

  test.each([
    ["event.record", "/api/tenants/acme/events", "POST", evt("a.b")],
    ["checkpoint.create", "/api/tenants/acme/checkpoints", "POST", undefined],
    ["action.upsert", "/api/actions/x.y", "PUT", { description: "X" }],
    ["events.export", "/api/tenants/acme/export", "GET", undefined],
  ] as const)(
    "a HookDeniedError on %s maps to its status, and nothing commits",
    async (type, path, method, body) => {
      const panel = makePanel({
        signer: hmacSigner("s"),
        hooks: {
          before(e) {
            if (e.type === type) throw new HookDeniedError("Quota exceeded", { status: 429 });
          },
        },
      });
      const res = await call<{ error: string; code: string }>(panel, path, {
        method,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: "Quota exceeded", code: "HOOK_DENIED" });
      if (type === "event.record") expect(await panel.core.count("acme")).toBe(0);
    },
  );

  test("HookDeniedError defaults to 403; a renamed copy (other bundle) is still detected", async () => {
    const copy = new Error("Nope");
    copy.name = "HookDeniedError";
    (copy as Error & { status?: number }).status = 409;
    let thrown: Error = new HookDeniedError("Denied");
    const panel = makePanel({
      hooks: {
        before() {
          throw thrown;
        },
      },
    });
    expect((await call(panel, "/api/tenants/acme/events", { body: evt("a.b") })).status).toBe(403);
    thrown = copy;
    expect((await call(panel, "/api/tenants/acme/events", { body: evt("a.b") })).status).toBe(409);
    const bare = new Error("bare");
    bare.name = "HookDeniedError";
    thrown = bare;
    expect((await call(panel, "/api/tenants/acme/events", { body: evt("a.b") })).status).toBe(403);
  });

  test("a plain Error from a before hook is a 500 (an unexpected bug)", async () => {
    const panel = makePanel({
      hooks: {
        before() {
          throw new Error("boom");
        },
      },
    });
    const res = await call<{ error: string }>(panel, "/api/tenants/acme/events", {
      body: evt("a.b"),
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("boom");
  });

  test("a throwing after hook never fails the request; onHookError receives it", async () => {
    const reported: string[] = [];
    const panel = makePanel({
      hooks: {
        after() {
          throw new Error("side effect failed");
        },
      },
      onHookError: (err, e) => void reported.push(`${e.type}:${(err as Error).message}`),
    });
    const res = await call(panel, "/api/tenants/acme/events", { body: evt("a.b") });
    expect(res.status).toBe(201);
    await flush();
    expect(reported).toEqual(["events.recorded:side effect failed"]);
  });
});
