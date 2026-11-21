import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { runWithAuditContext } from "../src/context.ts";
import {
  ConflictError,
  NotFoundError,
  ReadonlyError,
  SignerRequiredError,
  createAuditCore,
  eraseSections,
} from "../src/core.ts";
import { HookDeniedError, type AfterEvent, type BeforeEvent } from "../src/hooks/contract.ts";
import { ed25519Signer, generateSigningKeyPair, hmacSigner } from "../src/integrity.ts";
import { defineActions } from "../src/standard-schema.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { redact } from "../src/transforms.ts";
import { ValidationError } from "../src/validation.ts";

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const clock = (start = T0, step = 1000) => {
  let t = start;
  return { now: () => (t += step), set: (ms: number) => (t = ms) };
};

describe("record: validation", () => {
  const audit = createAuditCore({ storage: createMemoryStorage() });

  it("requires an actor (explicit or ambient)", async () => {
    await expect(audit.record({ tenant: "acme", action: "x.y" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects malformed tenants, actions, timestamps and oversized events", async () => {
    const actor = { id: "u" };
    await expect(audit.record({ tenant: "a/b", action: "x", actor })).rejects.toThrow(/tenant/);
    await expect(audit.record({ tenant: "a", action: "has space", actor })).rejects.toThrow(
      /action/,
    );
    await expect(
      audit.record({ tenant: "a", action: "x", actor, occurredAt: "nope" }),
    ).rejects.toThrow(/ISO-8601/);
    const small = createAuditCore({ storage: createMemoryStorage(), maxEventBytes: 64 });
    await expect(
      small.record({ tenant: "a", action: "x", actor, metadata: { big: "x".repeat(100) } }),
    ).rejects.toThrow(/limit is 64/);
  });

  it("normalizes occurredAt (Date or string) to ISO and defaults it to now", async () => {
    const c = clock();
    const a = createAuditCore({ storage: createMemoryStorage(), now: c.now });
    const one = await a.record({
      tenant: "t",
      action: "x",
      actor: { id: "u" },
      occurredAt: new Date(T0),
    });
    const two = await a.record({
      tenant: "t",
      action: "x",
      actor: { id: "u" },
      occurredAt: "2026-03-01T01:00:00Z",
    });
    const three = await a.record({ tenant: "t", action: "x", actor: { id: "u" } });
    expect(one.occurredAt).toBe("2026-03-01T00:00:00.000Z");
    expect(two.occurredAt).toBe("2026-03-01T01:00:00.000Z");
    expect(Date.parse(three.occurredAt)).toBeGreaterThan(T0);
  });
});

describe("record: typed actions (Standard Schema)", () => {
  const actions = defineActions({
    "invoice.paid": {
      metadata: v.object({ invoiceId: v.string(), amount: v.pipe(v.number(), v.minValue(0)) }),
      targets: ["invoice"],
      description: "An invoice was paid",
      group: "Billing",
    },
    "user.login": { outcome: "success" },
    "weird.output": {
      metadata: v.pipe(
        v.object({}),
        v.transform(() => "not-an-object"),
      ),
    },
  });

  it("validates metadata with the action's schema and stores the output", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage(), actions });
    const e = await audit.record({
      tenant: "acme",
      action: "invoice.paid",
      actor: { id: "u" },
      metadata: { invoiceId: "inv_1", amount: 10 },
    });
    expect(e.metadata).toEqual({ invoiceId: "inv_1", amount: 10 });
    await expect(
      // @ts-expect-error — amount must be a number
      audit.record({
        tenant: "acme",
        action: "invoice.paid",
        actor: { id: "u" },
        metadata: { invoiceId: "inv_1", amount: "10" },
      }),
    ).rejects.toThrow(/event\.metadata\.amount/);
  });

  it("is strict by default: unknown actions are rejected", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage(), actions });
    // @ts-expect-error — not in the action map
    await expect(audit.record({ tenant: "a", action: "nope", actor: { id: "u" } })).rejects.toThrow(
      /unknown action/,
    );
    const loose = createAuditCore({
      storage: createMemoryStorage(),
      actions,
      strictActions: false,
    });
    // Still a type error, but accepted at runtime.
    const unknownAction = { tenant: "a", action: "nope", actor: { id: "u" } } as never;
    await expect(loose.record(unknownAction)).resolves.toBeTruthy();
  });

  it("applies the spec's default outcome and rejects non-object schema output", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage(), actions });
    expect(
      (await audit.record({ tenant: "a", action: "user.login", actor: { id: "u" } })).outcome,
    ).toBe("success");
    await expect(
      audit.record({ tenant: "a", action: "weird.output", actor: { id: "u" }, metadata: {} }),
    ).rejects.toThrow(/must produce an object/);
  });

  it("syncs the catalog from code; UI entries can be added and removed", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage(), actions, selfAudit: false });
    const list = await audit.listActions();
    expect(list.map((a) => a.name)).toEqual(["invoice.paid", "user.login", "weird.output"]);
    expect(await audit.getAction("invoice.paid")).toMatchObject({
      source: "code",
      group: "Billing",
      targets: ["invoice"],
    });
    const added = await audit.upsertAction({
      name: "support.impersonated",
      description: "Support login",
    });
    expect(added.source).toBe("ui");
    expect((await audit.listActions()).map((a) => a.name)).toContain("support.impersonated");
    await expect(audit.deleteAction("invoice.paid")).rejects.toBeInstanceOf(ConflictError);
    await expect(audit.deleteAction("missing")).rejects.toBeInstanceOf(NotFoundError);
    await audit.deleteAction("support.impersonated");
    expect(await audit.getAction("support.impersonated")).toBeNull();
    await expect(audit.upsertAction({ name: "bad name" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("record: context, transforms, idempotency", () => {
  it("merges the ambient request context under explicit input", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const e = await runWithAuditContext(
      { tenant: "acme", actor: { id: "u_ctx" }, context: { ip: "1.1.1.1", requestId: "r1" } },
      () => audit.record({ action: "x.y", context: { requestId: "r2" } }),
    );
    expect(e).toMatchObject({
      tenant: "acme",
      actor: { id: "u_ctx" },
      context: { ip: "1.1.1.1", requestId: "r2" },
    });

    const noCtx = createAuditCore({ storage: createMemoryStorage(), context: false });
    await expect(
      runWithAuditContext({ tenant: "acme", actor: { id: "u" } }, () =>
        noCtx.record({ action: "x.y" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("runs transforms before chaining (the hash covers what is stored)", async () => {
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      transforms: [redact("metadata.password")],
    });
    const e = await audit.record({
      tenant: "t",
      action: "x",
      actor: { id: "u" },
      metadata: { password: "hunter2" },
    });
    expect(e.metadata).toEqual({ password: "[REDACTED]" });
    expect((await audit.verify("t")).ok).toBe(true);
  });

  it("explicit ids are idempotent; conflicting content is a ConflictError", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const input = {
      id: "evt_01JD0000000000000000000009",
      tenant: "t",
      action: "x",
      actor: { id: "u" },
      occurredAt: new Date(T0),
    };
    const a = await audit.record(input);
    const [b] = await audit.recordMany([input]);
    expect(b).toEqual(a);
    await expect(audit.record({ ...input, actor: { id: "other" } })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await audit.recordMany([])).toEqual([]);
  });
});

describe("hooks and the onRecord tap", () => {
  it("before hooks can deny recording and control-plane operations", async () => {
    const seen: string[] = [];
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      hooks: {
        before(event: BeforeEvent) {
          seen.push(event.type);
          if (event.type === "event.record" && event.tenant === "blocked") {
            throw new HookDeniedError("quota exceeded", { status: 429 });
          }
          if (event.type === "event.erase") throw new HookDeniedError("legal hold");
        },
      },
    });
    await expect(
      audit.record({ tenant: "blocked", action: "x", actor: { id: "u" } }),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(await audit.count("blocked")).toBe(0);
    const e = await audit.record({ tenant: "ok", action: "x", actor: { id: "u" } });
    await expect(audit.erase("ok", e.id)).rejects.toThrow("legal hold");
    expect(seen).toEqual(["event.record", "event.record", "event.erase"]);
  });

  it("after hooks observe commits; their errors are reported, never thrown", async () => {
    const after: AfterEvent[] = [];
    const onHookError = vi.fn();
    const onRecord = vi.fn();
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      onRecord,
      onHookError,
      hooks: [
        { after: (e) => void after.push(e) },
        {
          after() {
            throw new Error("boom");
          },
        },
      ],
    });
    await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(after.map((e) => e.type)).toEqual(["events.recorded"]);
    expect(onRecord).toHaveBeenCalledOnce();
    expect(onHookError).toHaveBeenCalledOnce();

    const throwingTap = createAuditCore({
      storage: createMemoryStorage(),
      onRecord: () => {
        throw new Error("tap");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      throwingTap.record({ tenant: "t", action: "x", actor: { id: "u" } }),
    ).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("self-audit", () => {
  it("records prunes, erasures, exports and catalog changes", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage(), retention: { keepLast: 1 } });
    for (let i = 0; i < 3; i++)
      await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await audit.prune();
    const [remaining] = (await audit.query({ tenant: "t", actions: ["x"] })).items;
    await audit.erase(
      "t",
      remaining!.id,
      { sections: ["metadata"], reason: "gdpr" },
      { actor: { id: "op_1", name: "Op" } },
    );
    await audit.noteExport("t", { tenant: "t" }, "csv", { actor: { id: "portal:t" } });
    await audit.upsertAction({ name: "custom.action" });
    const all = (await audit.query({ actions: ["audit_log.*"], order: "asc" })).items;
    expect(all.map((x) => [x.tenant, x.action, x.actor.type])).toEqual([
      ["t", "audit_log.pruned", "system"],
      ["t", "audit_log.erased", "operator"],
      ["t", "audit_log.exported", "portal"],
      ["_system", "audit_log.action_upserted", "system"],
    ]);
    expect((await audit.verify("t")).ok).toBe(true);
  });

  it("can be disabled", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage(), selfAudit: false });
    const e = await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await audit.erase("t", e.id);
    expect(await audit.count("t")).toBe(1);
  });
});

describe("erasure", () => {
  it("erases every section by default and validates section names", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const e = await audit.record({
      tenant: "t",
      action: "x",
      actor: { id: "u", email: "ada@example.com" },
      targets: [{ type: "user", id: "u2" }],
      context: { ip: "1.2.3.4" },
      metadata: { a: 1 },
      description: "Ada did x",
    });
    const erased = await audit.erase("t", e.id);
    expect(erased.integrity.erased).toEqual([
      "actor",
      "targets",
      "context",
      "metadata",
      "description",
    ]);
    expect(erased).toMatchObject({
      targets: [],
      context: { $erased: true },
      metadata: { $erased: true },
    });
    expect(erased.description).toBeUndefined();
    expect((await audit.verify("t")).ok).toBe(true);
    // @ts-expect-error — invalid section
    await expect(audit.erase("t", e.id, { sections: ["nope"] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(audit.erase("t", "evt_missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("eraseActor removes an actor across the tenant", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    for (let i = 0; i < 3; i++)
      await audit.record({ tenant: "t", action: "x", actor: { id: "leaver" } });
    await audit.record({ tenant: "t", action: "x", actor: { id: "stayer" } });
    expect(await audit.eraseActor("t", "leaver", { reason: "offboarding" })).toBe(3);
    expect((await audit.query({ tenant: "t", actorId: "leaver" })).items).toEqual([]);
    expect((await audit.verify("t")).ok).toBe(true);
  });

  it("eraseSections is idempotent and merges erased lists", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const e = await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    const once = eraseSections(e, ["metadata"]);
    expect(eraseSections(once, ["actor", "metadata"]).integrity.erased).toEqual([
      "actor",
      "metadata",
    ]);
  });
});

describe("checkpoints", () => {
  it("require a signer", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    await expect(audit.checkpoint("t")).rejects.toBeInstanceOf(SignerRequiredError);
    expect(await audit.jwks()).toEqual({ keys: [] });
  });

  it("sign the head on demand and automatically every N events", async () => {
    const pair = await generateSigningKeyPair();
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      signer: await ed25519Signer(pair.privateJwk),
      checkpoints: { every: 2 },
    });
    for (let i = 0; i < 4; i++)
      await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 20));
    const auto = await audit.listCheckpoints("t");
    expect(auto.map((c) => c.seq)).toEqual([2, 4]);
    const manual = await audit.checkpoint("t", { actor: { id: "op" } });
    expect(manual).toMatchObject({ kind: "head", seq: 4, alg: "Ed25519", keyId: pair.keyId });
    expect((await audit.jwks()).keys[0]).toMatchObject({ kid: pair.keyId, crv: "Ed25519" });
    const report = await audit.verify("t");
    expect(report).toMatchObject({ ok: true, signedThrough: 4 });
  });

  it("interval-based checkpoints fire on the next record after the interval", async () => {
    const c = clock();
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      signer: hmacSigner("s"),
      checkpoints: { interval: "1h" },
      now: c.now,
    });
    await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 10));
    expect((await audit.listCheckpoints("t")).length).toBe(1); // first: never checkpointed before
    await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 10));
    expect((await audit.listCheckpoints("t")).length).toBe(1);
    c.set(T0 + 2 * 3_600_000);
    await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 10));
    expect((await audit.listCheckpoints("t")).map((x) => x.seq)).toEqual([1, 3]);
  });
});

describe("verify", () => {
  it("detects tail truncation against the head", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    for (let i = 0; i < 4; i++)
      await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await audit.eventLog.deleteEventsThrough("t", 0); // no-op
    // Simulate an operator deleting the newest events behind the log's back.
    const storage = audit.options.storage as ReturnType<typeof createMemoryStorage>;
    const last = await storage.lastEvent("t");
    expect(last?.seq).toBe(4);
    const tail = await audit.eventsBySeq("t", { afterSeq: 0, limit: 10 });
    const keep = tail.slice(0, 2);
    const fresh = createMemoryStorage();
    await fresh.appendEvents("t", keep, { expectedSeq: 0 });
    await fresh.setItem("aud/t/t/head", await storage.getItem("aud/t/t/head"));
    const forked = createAuditCore({ storage: fresh });
    const report = await forked.verify("t");
    expect(report.ok).toBe(false);
    expect(report.issues.at(-1)).toMatchObject({ kind: "seq-gap", seq: 3 });
  });

  it("verifies sub-ranges and empty tenants", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    expect(await audit.verify("empty")).toMatchObject({ ok: true, checked: 0, anchor: "none" });
    for (let i = 0; i < 5; i++)
      await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    expect(await audit.verify("t", { fromSeq: 2, toSeq: 4 })).toMatchObject({
      ok: true,
      checked: 3,
      fromSeq: 2,
      toSeq: 4,
      anchor: "unanchored",
    });
    await expect(audit.verify("bad/tenant")).rejects.toBeInstanceOf(ValidationError);
  });

  it("verifies across page boundaries", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const batch = Array.from({ length: 1200 }, () => ({
      tenant: "big",
      action: "x",
      actor: { id: "u" },
    }));
    await audit.recordMany(batch);
    const report = await audit.verify("big");
    expect(report).toMatchObject({ ok: true, checked: 1200, fromSeq: 1, toSeq: 1200 });
  });
});

describe("retention", () => {
  it("maxAge prunes by recordedAt; union with keepLast keeps either", async () => {
    let now = T0;
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      retention: { maxAge: "3h", keepLast: 2 },
      selfAudit: false,
      now: () => now,
    });
    for (let i = 1; i <= 6; i++) {
      now = T0 + i * 3_600_000;
      await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    }
    now = T0 + 7 * 3_600_000;
    const [r] = await audit.prune();
    // recordedAt hours: 1..6, now=7 → older than 3h: seqs 1..3; keepLast 2 protects 5, 6 only.
    // Recorded at hours 1..6, now = 7: older than 3h are seqs 1..3 (hour 4 is exactly 3h old: kept).
    expect(r).toEqual({ tenant: "t", pruned: 3, baseSeq: 4 });
    expect((await audit.verify("t")).ok).toBe(true);
  });

  it("per-tenant overrides, no-op without rules, and retention floors", async () => {
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      retention: { tenants: { short: { keepLast: 1 } } },
      selfAudit: false,
    });
    for (const t of ["short", "long"]) {
      for (let i = 0; i < 4; i++)
        await audit.record({ tenant: t, action: "x", actor: { id: "u" } });
    }
    const unregister = audit.addRetentionFloor(async (tenant) => (tenant === "short" ? 2 : null));
    expect(await audit.pruneTenant("short")).toEqual({ tenant: "short", pruned: 2, baseSeq: 3 });
    expect(await audit.pruneTenant("long")).toEqual({ tenant: "long", pruned: 0, baseSeq: 1 });
    unregister();
    expect(await audit.pruneTenant("short")).toEqual({ tenant: "short", pruned: 1, baseSeq: 4 });
  });

  it("readonly blocks control-plane mutations but not reads", async () => {
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      readonly: true,
      retention: { keepLast: 1 },
    });
    const e = await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await expect(audit.erase("t", e.id)).rejects.toBeInstanceOf(ReadonlyError);
    await expect(audit.prune()).rejects.toBeInstanceOf(ReadonlyError);
    await expect(audit.upsertAction({ name: "a" })).rejects.toBeInstanceOf(ReadonlyError);
    await expect(audit.deleteAction("a")).rejects.toBeInstanceOf(ReadonlyError);
    expect((await audit.query()).items).toHaveLength(1);
  });
});
