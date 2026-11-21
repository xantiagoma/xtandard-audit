/**
 * The buffered recorder (ADR 0002): fire-and-forget recording for hot paths
 * that must not wait on the database, without ever dropping an event silently.
 *
 * - `record()` validates **synchronously** (structural checks — programmer
 *   errors throw at the call site) and enqueues; it returns immediately.
 * - Batches flush per tenant when `batchSize` is reached or every
 *   `flushIntervalMs`, through `core.recordMany` (one chain append per tenant).
 * - A failed batch is retried with exponential backoff (`retry`). When retries
 *   are exhausted the batch goes to `fallback` (if any) **and** `onError`
 *   fires; without a fallback it stays queued for the next flush.
 * - The queue is bounded by `maxQueue`; past it `record()` throws
 *   {@link RecorderOverflowError} — backpressure instead of silent loss.
 * - `flush()` drains now; `close()` stops the timer and drains (call it on
 *   shutdown). A hard crash can lose what is still in memory — use
 *   `core.record` (or a durable `fallback`) where that is unacceptable.
 *
 * @module
 */

import type { AuditCore, RecordInput } from "./core.ts";
import type { AuditEvent } from "./schema.ts";
import type { ActionMap } from "./standard-schema.ts";
import { getAuditContext } from "./context.ts";
import { newId } from "./id.ts";
import { assertValid, validateEventInput } from "./validation.ts";

/** Thrown by {@link Recorder.record} when the queue is full. */
export class RecorderOverflowError extends Error {
  constructor(maxQueue: number) {
    super(`Audit recorder queue is full (${maxQueue} events); events are not being persisted`);
    this.name = "RecorderOverflowError";
  }
}

/** Where batches go when storage keeps failing (e.g. a JSONL file, stderr, a queue). */
export interface RecorderFallback {
  write(inputs: RecordInput[], error: unknown): void | Promise<void>;
}

/** Options for {@link createRecorder}. */
export interface RecorderOptions {
  /** Flush when this many events are queued. Default 100. */
  batchSize?: number;
  /** Flush at least this often. Default 1000 ms. */
  flushIntervalMs?: number;
  /** Max events held in memory. Default 10 000. */
  maxQueue?: number;
  /** Retries per batch before giving up to the fallback. Default `{ attempts: 3, baseDelayMs: 200 }`. */
  retry?: { attempts?: number; baseDelayMs?: number };
  /** Receives batches that exhausted their retries. */
  fallback?: RecorderFallback;
  /** Called for every batch that exhausted its retries (always, fallback or not). */
  onError?: (error: unknown, inputs: RecordInput[]) => void;
  /** Called after each committed batch. */
  onFlush?: (events: AuditEvent[]) => void;
}

/** A buffered recorder over a core. */
export interface Recorder<A extends ActionMap = ActionMap> {
  /** Enqueue an event. Throws synchronously on invalid input or overflow. */
  record(input: RecordInput<A>): void;
  /** Flush everything queued now. Resolves when the queue is drained (or parked). */
  flush(): Promise<void>;
  /** Stop the timer and flush. */
  close(): Promise<void>;
  /** Events waiting to be persisted. */
  readonly pending: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Create a buffered recorder.
 *
 * @example
 * ```ts
 * import { createAuditCore, createRecorder } from "@xtandard/audit";
 *
 * const audit = createAuditCore({ storage });
 * const recorder = createRecorder(audit, {
 *   batchSize: 200,
 *   onError: (err, batch) => logger.error({ err, lost: batch.length }, "audit backlog"),
 * });
 *
 * recorder.record({ tenant: "acme", action: "user.login", actor: { id: "u_1" } });
 * process.on("SIGTERM", () => recorder.close());
 * ```
 */
export function createRecorder<A extends ActionMap>(
  core: AuditCore<A>,
  options: RecorderOptions = {},
): Recorder<A> {
  const batchSize = options.batchSize ?? 100;
  const intervalMs = options.flushIntervalMs ?? 1000;
  const maxQueue = options.maxQueue ?? 10_000;
  const attempts = options.retry?.attempts ?? 3;
  const baseDelayMs = options.retry?.baseDelayMs ?? 200;

  let queue: RecordInput<A>[] = [];
  let flushing: Promise<void> | null = null;
  let closed = false;
  const timer = setInterval(() => void flush(), intervalMs);
  (timer as { unref?: () => void }).unref?.();

  async function persist(batch: RecordInput<A>[]): Promise<void> {
    let lastError: unknown;
    for (let i = 0; i <= attempts; i++) {
      try {
        const events = await core.recordMany(batch);
        options.onFlush?.(events);
        return;
      } catch (err) {
        lastError = err;
        if (i < attempts) await sleep(baseDelayMs * 2 ** i);
      }
    }
    options.onError?.(lastError, batch as RecordInput[]);
    if (options.fallback) {
      await options.fallback.write(batch as RecordInput[], lastError);
    } else {
      // Park it back at the front: retried on the next flush, bounded by maxQueue.
      queue = [...batch, ...queue];
      throw lastError;
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      queue = queue.slice(batch.length);
      try {
        await persist(batch);
      } catch {
        return; // parked; try again next tick
      }
    }
  }

  function flush(): Promise<void> {
    if (!flushing) {
      flushing = drain().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  return {
    record(input) {
      if (closed) throw new Error("Audit recorder is closed");
      if (queue.length >= maxQueue) throw new RecorderOverflowError(maxQueue);
      // Resolve ambient context now: the flush runs outside the caller's async scope.
      const scope = getAuditContext();
      const raw = input as RecordInput;
      const resolved = {
        ...raw,
        ...(raw.tenant === undefined && scope?.tenant ? { tenant: scope.tenant } : {}),
        ...(raw.actor === undefined && scope?.actor ? { actor: scope.actor } : {}),
        ...(scope?.context ? { context: { ...scope.context, ...raw.context } } : {}),
        occurredAt: raw.occurredAt ?? new Date(),
        // An id fixed at enqueue time makes retries and fallback replays idempotent: a batch
        // that partially committed (recordMany commits per tenant) is not duplicated.
        id: raw.id ?? newId("evt"),
      };
      assertValid(validateEventInput(resolved));
      queue.push(resolved as RecordInput<A>);
      if (queue.length >= batchSize) void flush();
    },
    flush,
    async close() {
      closed = true;
      clearInterval(timer);
      await flush();
    },
    get pending() {
      return queue.length;
    },
  };
}
