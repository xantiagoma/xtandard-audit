import { describe, expect, test } from "vitest";
import { hmacSigner } from "../src/integrity.ts";
import { callbackSink } from "../src/streams.ts";
import {
  collectingSink,
  createTestAudit,
  expectNotRecorded,
  expectRecorded,
} from "../src/testing.ts";

describe("createTestAudit", () => {
  test("records in memory and streams to the collecting sink on flush()", async () => {
    const { core, sink, flush, events } = createTestAudit();
    await core.record({ tenant: "acme", action: "invoice.paid", actor: { id: "u1" } });
    await core.record({ tenant: "globex", action: "user.login", actor: { id: "g1" } });
    expect(sink.events()).toEqual([]); // nothing runs until flush()
    await flush();
    expect(
      sink
        .events()
        .map((e) => e.action)
        .sort(),
    ).toEqual(["invoice.paid", "user.login"]);
    expect(sink.batches.map((b) => b.tenant).sort()).toEqual(["acme", "globex"]);
    expect((await events()).map((e) => e.tenant)).toEqual(["acme", "globex"]);
    expect((await events("acme")).map((e) => e.action)).toEqual(["invoice.paid"]);
  });

  test("failNext exercises the stream retry path (no backoff in tests)", async () => {
    const { core, sink, flush, streams } = createTestAudit();
    await core.record({ tenant: "acme", action: "a.b", actor: { id: "u" } });
    sink.failNext(1, new Error("SIEM down"));
    await flush();
    expect(sink.events()).toEqual([]);
    const status = await streams.status();
    expect(status[0]!.tenants[0]).toMatchObject({ failures: 1, lastError: "SIEM down" });
    await flush();
    expect(sink.events()).toHaveLength(1);
    sink.clear();
    expect(sink.batches).toEqual([]);
  });

  test("streams checkpoints too, and passes core options through", async () => {
    const { core, sink, flush } = createTestAudit({ signer: hmacSigner("s") });
    await core.record({ tenant: "acme", action: "a.b", actor: { id: "u" } });
    await core.checkpoint("acme");
    await flush();
    expect(sink.checkpoints()).toHaveLength(1);
  });

  test("extra streams run beside the built-in one", async () => {
    const seen: number[] = [];
    const { core, flush } = createTestAudit({
      streams: [
        {
          name: "extra",
          startFrom: "beginning",
          sink: callbackSink((b) => void seen.push(b.items.length)),
        },
      ],
    });
    await core.record({ tenant: "acme", action: "a.b", actor: { id: "u" } });
    await flush();
    expect(seen).toEqual([1]);
  });

  test("optionally builds a panel over the same core", async () => {
    const { core, panel } = createTestAudit({ panel: { title: "Test panel" } });
    await core.record({ tenant: "acme", action: "a.b", actor: { id: "u" } });
    const res = await panel!.fetch(new Request("http://x/api/tenants"));
    expect(((await res.json()) as { key: string }[]).map((t) => t.key)).toEqual(["acme"]);
    expect(createTestAudit({ panel: true }).panel).not.toBeNull();
    expect(createTestAudit().panel).toBeNull();
  });
});

describe("expectRecorded / expectNotRecorded", () => {
  test("deep-subset matching on actor, targets, metadata and context", async () => {
    const { core } = createTestAudit();
    await core.record({
      tenant: "acme",
      action: "member.role_changed",
      actor: { id: "u1", name: "Ada" },
      targets: [
        { type: "user", id: "u2" },
        { type: "team", id: "t1" },
      ],
      metadata: { from: "member", to: "admin", nested: { a: [1, 2] } },
      context: { ip: "1.2.3.4" },
    });
    const event = await expectRecorded(core, {
      tenant: "acme",
      action: "member.role_changed",
      actor: { id: "u1" },
      targets: [{ type: "user", id: "u2" }],
      metadata: { to: "admin", nested: { a: [2] } },
      context: { ip: "1.2.3.4" },
    });
    expect(event.seq).toBe(1);
    await expectRecorded(core, { action: "member.role_changed" });
    await expectNotRecorded(core, { action: "member.role_changed", metadata: { to: "owner" } });
    await expectNotRecorded(core, { tenant: "globex" });
  });

  test("failures describe what was recorded instead", async () => {
    const { core } = createTestAudit();
    await core.record({ tenant: "acme", action: "a.b", actor: { id: "u1" } });
    await expect(expectRecorded(core, { tenant: "acme", actor: { id: "u9" } })).rejects.toThrow(
      /Candidates \(1\):\n {2}- \[acme#1\] a\.b by u1/,
    );
    await expect(expectRecorded(core, { action: "zzz" })).rejects.toThrow(/No candidate events/);
    await expect(expectNotRecorded(core, { action: "a.b" })).rejects.toThrow(/but found evt_/);
  });

  test("handles mismatched shapes", async () => {
    const { core } = createTestAudit();
    await core.record({ tenant: "acme", action: "a.b", actor: { id: "u1" }, metadata: { x: 1 } });
    await expectNotRecorded(core, { metadata: { x: { deep: 1 } } });
    await expectNotRecorded(core, { targets: [{ id: "nope" }] });
    await expectNotRecorded(core, { metadata: { x: [1] } as never });
  });
});

describe("collectingSink", () => {
  test("is a sink with a kind and a default failure", async () => {
    const sink = collectingSink("custom");
    expect(sink.kind).toBe("custom");
    sink.failNext();
    await expect(sink.send({ stream: "s", tenant: "t", items: [] })).rejects.toThrow(
      /simulated failure/,
    );
    await sink.send({ stream: "s", tenant: "t", items: [] });
    expect(sink.batches).toHaveLength(1);
  });
});
