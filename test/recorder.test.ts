import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithAuditContext } from "../src/context.ts";
import { createAuditCore } from "../src/core.ts";
import { RecorderOverflowError, createRecorder } from "../src/recorder.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { ValidationError } from "../src/validation.ts";

afterEach(() => vi.useRealTimers());

describe("createRecorder", () => {
  it("flushes in batches of at most batchSize", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const onFlush = vi.fn();
    const recorder = createRecorder(audit, { batchSize: 3, flushIntervalMs: 60_000, onFlush });
    for (let i = 0; i < 4; i++) recorder.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 10));
    // Hitting batchSize starts a drain that empties the queue in batches of at most 3.
    expect(onFlush.mock.calls.map(([events]) => events.length)).toEqual([3, 1]);
    await recorder.close();
    expect(recorder.pending).toBe(0);
    expect(await audit.count("t")).toBe(4);
    expect(() => recorder.record({ tenant: "t", action: "x", actor: { id: "u" } })).toThrow(
      /closed/,
    );
  });

  it("validates synchronously and captures the ambient context at call time", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const recorder = createRecorder(audit, { flushIntervalMs: 60_000 });
    expect(() =>
      recorder.record({ tenant: "bad/tenant", action: "x", actor: { id: "u" } }),
    ).toThrow(ValidationError);
    runWithAuditContext({ tenant: "ctx", actor: { id: "u_ctx" }, context: { ip: "1.1.1.1" } }, () =>
      recorder.record({ action: "x" }),
    );
    await recorder.flush();
    const [e] = (await audit.query({ tenant: "ctx" })).items;
    expect(e).toMatchObject({ actor: { id: "u_ctx" }, context: { ip: "1.1.1.1" } });
    await recorder.close();
  });

  it("retries, then parks the batch when there is no fallback (never drops)", async () => {
    const storage = createMemoryStorage();
    const audit = createAuditCore({ storage });
    const real = audit.recordMany;
    let failures = 2;
    audit.recordMany = async (inputs) => {
      if (failures-- > 0) throw new Error("db down");
      return real(inputs);
    };
    const onError = vi.fn();
    const recorder = createRecorder(audit, {
      retry: { attempts: 0 },
      flushIntervalMs: 60_000,
      onError,
    });
    recorder.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await recorder.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(recorder.pending).toBe(1);
    await recorder.flush();
    expect(recorder.pending).toBe(1);
    await recorder.flush();
    expect(recorder.pending).toBe(0);
    expect(await audit.count("t")).toBe(1);
    await recorder.close();
  });

  it("hands exhausted batches to the fallback", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    audit.recordMany = async () => {
      throw new Error("db down");
    };
    const written: unknown[] = [];
    const recorder = createRecorder(audit, {
      retry: { attempts: 1, baseDelayMs: 1 },
      flushIntervalMs: 60_000,
      fallback: { write: (inputs) => void written.push(...inputs) },
    });
    recorder.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await recorder.close();
    expect(written).toHaveLength(1);
    expect(recorder.pending).toBe(0);
  });

  it("applies backpressure with RecorderOverflowError", () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const recorder = createRecorder(audit, { maxQueue: 2, batchSize: 10, flushIntervalMs: 60_000 });
    recorder.record({ tenant: "t", action: "x", actor: { id: "u" } });
    recorder.record({ tenant: "t", action: "x", actor: { id: "u" } });
    expect(() => recorder.record({ tenant: "t", action: "x", actor: { id: "u" } })).toThrow(
      RecorderOverflowError,
    );
    void recorder.close();
  });

  it("flushes on its interval", async () => {
    vi.useFakeTimers();
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const recorder = createRecorder(audit, { flushIntervalMs: 100 });
    recorder.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();
    await recorder.flush();
    expect(await audit.count("t")).toBe(1);
    await recorder.close();
  });
});

describe("recorder idempotency", () => {
  it("assigns ids at enqueue, so replaying a partially committed batch does not duplicate", async () => {
    const audit = createAuditCore({ storage: createMemoryStorage() });
    const real = audit.recordMany.bind(audit);
    let first = true;
    audit.recordMany = async (inputs) => {
      if (first) {
        first = false;
        await real(inputs.filter((i) => i.tenant === "a")); // tenant "a" commits…
        throw new Error("db down"); // …then the batch fails
      }
      return real(inputs);
    };
    const recorder = createRecorder(audit, {
      retry: { attempts: 1, baseDelayMs: 1 },
      flushIntervalMs: 60_000,
    });
    recorder.record({ tenant: "a", action: "x", actor: { id: "u" } });
    recorder.record({ tenant: "b", action: "x", actor: { id: "u" } });
    await recorder.close();
    expect(await audit.count("a")).toBe(1);
    expect(await audit.count("b")).toBe(1);
  });
});
