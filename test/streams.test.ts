import { describe, expect, it, vi } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { hmacSigner } from "../src/integrity.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { callbackSink, createStreamRunner, type StreamBatch } from "../src/streams.ts";

const quiet = () => {};

function setup(opts: { startFrom?: "beginning" | "now"; fail?: number } = {}) {
  const audit = createAuditCore({
    storage: createMemoryStorage(),
    signer: hmacSigner("s"),
    checkpoints: false,
  });
  const batches: StreamBatch[] = [];
  let fail = opts.fail ?? 0;
  const sink = callbackSink((b) => {
    if (fail-- > 0) throw new Error("sink down");
    batches.push(b);
  });
  const runner = createStreamRunner(audit, {
    streams: [{ name: "siem", sink, startFrom: opts.startFrom ?? "beginning", batchSize: 2 }],
    onError: quiet,
  });
  return { audit, batches, runner };
}

const seqs = (batches: StreamBatch[]) =>
  batches.flatMap((b) =>
    b.items.map((i) =>
      i.kind === "event" ? `${b.tenant}:${i.event.seq}` : `cp:${i.checkpoint.seq}`,
    ),
  );

describe("createStreamRunner", () => {
  it("delivers every event per tenant in seq order, in batches, with checkpoints", async () => {
    const { audit, batches, runner } = setup();
    for (let i = 0; i < 3; i++)
      await audit.record({ tenant: "a", action: "x", actor: { id: "u" } });
    await audit.record({ tenant: "b", action: "x", actor: { id: "u" } });
    await audit.checkpoint("a");
    await runner.tick();
    expect(seqs(batches)).toEqual(["a:1", "a:2", "a:3", "cp:3", "b:1"]);
    expect(batches.every((b) => b.items.filter((i) => i.kind === "event").length <= 2)).toBe(true);
    await runner.tick();
    expect(seqs(batches)).toHaveLength(5); // nothing new, nothing re-sent
    const status = await runner.status();
    expect(status[0]!.tenants.map((t) => [t.tenant, t.lag])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("startFrom now skips history", async () => {
    const { audit, batches, runner } = setup({ startFrom: "now" });
    await audit.record({ tenant: "a", action: "x", actor: { id: "u" } });
    await audit.checkpoint("a");
    await runner.tick(); // cursor initialized at the head
    await audit.record({ tenant: "a", action: "x", actor: { id: "u" } });
    await runner.tick();
    expect(seqs(batches)).toEqual(["a:2"]);
  });

  it("backs off on failure without advancing, then retries", async () => {
    const { audit, batches, runner } = setup({ fail: 1 });
    await audit.record({ tenant: "a", action: "x", actor: { id: "u" } });
    await runner.tick();
    let [s] = await runner.status();
    expect(s!.tenants[0]).toMatchObject({ lag: 1, failures: 1, lastError: "sink down" });
    await runner.tick(); // still backing off
    expect(batches).toHaveLength(0);
    await runner.retry("siem", "a");
    await runner.tick();
    expect(seqs(batches)).toEqual(["a:1"]);
    [s] = await runner.status();
    expect(s!.tenants[0]).toMatchObject({ lag: 0, failures: 0 });
    await runner.retry("missing");
  });

  it("filters and tenant lists; retention will not prune undelivered events", async () => {
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      retention: { keepLast: 1 },
      selfAudit: false,
    });
    const got: StreamBatch[] = [];
    const runner = createStreamRunner(audit, {
      streams: [
        {
          name: "billing",
          sink: callbackSink((b) => void got.push(b)),
          tenants: ["a"],
          filter: { actions: ["invoice.*"] },
          startFrom: "beginning",
          checkpoints: false,
        },
      ],
    });
    await audit.record({ tenant: "a", action: "invoice.paid", actor: { id: "u" } });
    await audit.record({ tenant: "a", action: "user.login", actor: { id: "u" } });
    await audit.record({ tenant: "b", action: "invoice.paid", actor: { id: "u" } });
    await runner.tick();
    expect(seqs(got)).toEqual(["a:1"]);
    await audit.record({ tenant: "a", action: "invoice.paid", actor: { id: "u" } });
    await audit.record({ tenant: "a", action: "invoice.paid", actor: { id: "u" } });
    // Cursor is at 2; keepLast 1 would prune through 3, the floor holds it at 2.
    expect(await audit.pruneTenant("a")).toMatchObject({ pruned: 2, baseSeq: 3 });
    await runner.stop();
  });

  it("validates stream names and runs on a timer", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const sink = callbackSink(() => {});
    expect(() => createStreamRunner(audit, { streams: [{ name: "bad name", sink }] })).toThrow(
      /Invalid/,
    );
    expect(() =>
      createStreamRunner(audit, {
        streams: [
          { name: "a", sink },
          { name: "a", sink },
        ],
      }),
    ).toThrow(/Duplicate/);
    const send = vi.fn();
    const runner = createStreamRunner(audit, {
      streams: [{ name: "t", sink: callbackSink(send), startFrom: "beginning" }],
      interval: 10,
    });
    await audit.record({ tenant: "a", action: "x", actor: { id: "u" } });
    runner.start();
    runner.start();
    await new Promise((r) => setTimeout(r, 40));
    await runner.stop();
    expect(send).toHaveBeenCalled();
  });
});
