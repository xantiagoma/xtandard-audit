/**
 * Streaming (ADR 0008): push events — and signed checkpoints — to SIEMs and
 * sinks by **reading the log**, not by queueing on the record path.
 *
 * Each stream keeps one cursor per tenant (`aud/streams/{name}/cursors/{tenant}`
 * = the last seq the sink acknowledged). A tick reads the next batch with
 * `eventsBySeq`, applies the stream's filter, calls `sink.send`, and advances
 * the cursor only after the sink resolved. At-least-once: sinks dedupe on
 * `event.id`. Failures back off exponentially per (stream, tenant); nothing is
 * dropped — the cursor simply does not move. Retention will not prune past the
 * slowest cursor (the runner registers a retention floor on the core).
 *
 * @module
 */

import type { AuditCore } from "./core.ts";
import { durationToMs } from "./duration.ts";
import { streamCursorKey, streamLeaseKey, streamMetaKey } from "./keys.ts";
import { matchesQuery, normalizeQuery } from "./query.ts";
import type { AuditCheckpoint, AuditDuration, AuditEvent, AuditQuery } from "./schema.ts";
import type { ActionMap } from "./standard-schema.ts";
import { isCompareAndSwap } from "./storage/contract.ts";

/** One item a sink receives. */
export type StreamItem =
  | { kind: "event"; event: AuditEvent }
  | { kind: "checkpoint"; checkpoint: AuditCheckpoint };

/** A batch for one tenant. */
export interface StreamBatch {
  stream: string;
  tenant: string;
  items: StreamItem[];
}

/**
 * A destination. `send` must resolve only once the batch is durably accepted
 * (2xx, flushed, …) and throw otherwise — the cursor advances on resolve.
 */
export interface AuditSink {
  /** Short kind label for the UI (`"http"`, `"datadog"`, …). */
  readonly kind: string;
  send(batch: StreamBatch): Promise<void>;
  /** Optional cleanup on runner stop. */
  close?(): Promise<void>;
}

/** A stream definition. */
export interface StreamDefinition {
  /** Unique name; the cursor key. Allowed: `a-z A-Z 0-9 . _ -`. */
  name: string;
  sink: AuditSink;
  /** Only these tenants (default: all). */
  tenants?: string[];
  /** Only events matching this query's filters (tenant/pagination fields are ignored). */
  filter?: Omit<AuditQuery, "tenant" | "limit" | "cursor" | "order">;
  /** Also stream signed checkpoints (default `true`). */
  checkpoints?: boolean;
  /** Max items per `send`. Default 100. */
  batchSize?: number;
  /**
   * Where the stream starts the first time it runs: `"beginning"` (replay every retained log)
   * or `"now"` (tenants that already exist start at their current head; tenants created later
   * are streamed from their first event). Default `"now"`.
   */
  startFrom?: "beginning" | "now";
}

/** Persisted per-tenant cursor state. */
export interface StreamCursor {
  /** Last acknowledged seq. */
  seq: number;
  /** Last checkpoint id acknowledged (checkpoints are streamed in id order). */
  checkpointId?: string;
  failures: number;
  lastError?: string;
  lastErrorAt?: string;
  nextAttemptAt?: string;
  lastDeliveredAt?: string;
}

/** Runtime status of one stream (the admin UI's Streams view). */
export interface StreamStatus {
  name: string;
  kind: string;
  tenants: {
    tenant: string;
    cursor: number;
    headSeq: number;
    lag: number;
    failures: number;
    lastError?: string;
    lastErrorAt?: string;
    nextAttemptAt?: string;
    lastDeliveredAt?: string;
  }[];
}

/** Options for {@link createStreamRunner}. */
export interface StreamRunnerOptions {
  streams: StreamDefinition[];
  /** Tick interval. Default `"2s"`. */
  interval?: AuditDuration;
  /** Max backoff between failed attempts. Default `"10m"`. */
  maxBackoff?: AuditDuration;
  /** Lease duration when several processes run streams (needs compare-and-swap storage). Default `"30s"`. */
  lease?: AuditDuration;
  /** Called on every failed send. Default `console.warn`. */
  onError?: (error: unknown, info: { stream: string; tenant: string }) => void;
}

/** A started (or startable) stream runner. */
export interface StreamRunner {
  start(): void;
  stop(): Promise<void>;
  /** Run one pass over every stream and tenant now (tests, cron triggers). */
  tick(): Promise<void>;
  status(): Promise<StreamStatus[]>;
  /** Clear a tenant's backoff so the next tick retries immediately. */
  retry(stream: string, tenant?: string): Promise<void>;
  readonly streams: readonly StreamDefinition[];
}

const NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Create a stream runner over a core. The panel creates and starts one when
 * given `streams`; call `start()` yourself otherwise (timers are `unref`ed).
 *
 * @example
 * ```ts
 * import { createStreamRunner } from "@xtandard/audit";
 * import { httpSink } from "@xtandard/audit/sinks/http";
 *
 * const runner = createStreamRunner(audit, {
 *   streams: [{ name: "siem", sink: httpSink({ url: "https://siem.example/ingest" }) }],
 * });
 * runner.start();
 * ```
 */
export function createStreamRunner<A extends ActionMap>(
  core: AuditCore<A>,
  options: StreamRunnerOptions,
): StreamRunner {
  const storage = core.options.storage;
  const now = core.options.now;
  const intervalMs = durationToMs(options.interval ?? "2s");
  const maxBackoffMs = durationToMs(options.maxBackoff ?? "10m");
  const leaseMs = durationToMs(options.lease ?? "30s");
  const cas = isCompareAndSwap(storage) ? storage : null;
  const ownerId = Math.random().toString(36).slice(2);
  const onError =
    options.onError ??
    ((error: unknown, info: { stream: string; tenant: string }) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[@xtandard/audit] stream "${info.stream}" → tenant "${info.tenant}" failed:`,
        error,
      );
    });

  const names = new Set<string>();
  for (const s of options.streams) {
    if (!NAME_RE.test(s.name)) throw new TypeError(`Invalid stream name "${s.name}"`);
    if (names.has(s.name)) throw new TypeError(`Duplicate stream name "${s.name}"`);
    names.add(s.name);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  async function tenantsFor(stream: StreamDefinition): Promise<string[]> {
    const all = (await core.listTenants()).map((t) => t.key);
    return stream.tenants ? all.filter((t) => stream.tenants!.includes(t)) : all;
  }

  /**
   * The first time a stream ever runs, `startFrom: "now"` pins every tenant that exists at that
   * moment to its current head. Tenants that appear later start from the beginning of their log —
   * otherwise events recorded before the runner first noticed a new tenant would never be streamed.
   */
  async function ensureStarted(stream: StreamDefinition): Promise<void> {
    const key = streamMetaKey(stream.name);
    if (await storage.getItem(key)) return;
    if ((stream.startFrom ?? "now") === "now") {
      for (const tenant of await tenantsFor(stream)) {
        const cursorKey = streamCursorKey(stream.name, tenant);
        if (await storage.getItem(cursorKey)) continue;
        const head = await core.head(tenant);
        const cps = await core.listCheckpoints(tenant);
        const last = cps[cps.length - 1];
        await storage.setItem(cursorKey, {
          seq: head.seq,
          failures: 0,
          ...(last ? { checkpointId: last.id } : {}),
        } satisfies StreamCursor);
      }
    }
    await storage.setItem(key, { startedAt: new Date(now()).toISOString() });
  }

  async function readCursor(stream: StreamDefinition, tenant: string): Promise<StreamCursor> {
    const existing = await storage.getItem<StreamCursor>(streamCursorKey(stream.name, tenant));
    if (existing) return existing;
    const head = await core.head(tenant);
    const cursor: StreamCursor = { seq: (head.baseSeq ?? 1) - 1, failures: 0 };
    await storage.setItem(streamCursorKey(stream.name, tenant), cursor);
    return cursor;
  }

  async function acquireLease(stream: StreamDefinition): Promise<boolean> {
    if (!cas) return true; // single-runner assumption (documented)
    const key = streamLeaseKey(stream.name);
    const current = await storage.getItem<{ owner: string; until: number }>(key);
    const t = now();
    if (current && current.owner !== ownerId && current.until > t) return false;
    return cas.compareAndSwap({
      key,
      expected: current,
      next: { owner: ownerId, until: t + leaseMs },
    });
  }

  async function pumpTenant(stream: StreamDefinition, tenant: string): Promise<void> {
    let cursor = await readCursor(stream, tenant);
    if (cursor.nextAttemptAt && Date.parse(cursor.nextAttemptAt) > now()) return;
    const batchSize = stream.batchSize ?? 100;
    const filter = stream.filter ? normalizeQuery({ ...stream.filter, tenant }) : null;
    const head = await core.head(tenant);
    // A pruned prefix the stream never saw cannot be delivered any more; skip to the base.
    if (head.baseSeq && cursor.seq < head.baseSeq - 1)
      cursor = { ...cursor, seq: head.baseSeq - 1 };

    for (;;) {
      // Renew the lease per batch so a long backlog cannot outlive it (another instance would
      // then pump the same stream concurrently).
      if (!(await acquireLease(stream))) return;
      const events = await core.eventsBySeq(tenant, { afterSeq: cursor.seq, limit: batchSize });
      const items: StreamItem[] = [];
      for (const event of events) {
        if (!filter || matchesQuery(event, filter)) items.push({ kind: "event", event });
      }
      let checkpointId = cursor.checkpointId;
      if (stream.checkpoints ?? true) {
        const lastSeq = events[events.length - 1]?.seq ?? cursor.seq;
        for (const cp of await core.listCheckpoints(tenant)) {
          if ((checkpointId && cp.id <= checkpointId) || cp.seq > lastSeq) continue;
          items.push({ kind: "checkpoint", checkpoint: cp });
          checkpointId = cp.id;
        }
      }
      if (events.length === 0 && items.length === 0) return;
      const lastSeq = events[events.length - 1]?.seq ?? cursor.seq;
      try {
        if (items.length > 0) await stream.sink.send({ stream: stream.name, tenant, items });
      } catch (err) {
        const failures = cursor.failures + 1;
        const backoff = Math.min(maxBackoffMs, 1000 * 2 ** Math.min(failures - 1, 20));
        await storage.setItem(streamCursorKey(stream.name, tenant), {
          ...cursor,
          failures,
          lastError: err instanceof Error ? err.message : String(err),
          lastErrorAt: new Date(now()).toISOString(),
          nextAttemptAt: new Date(now() + backoff).toISOString(),
        } satisfies StreamCursor);
        onError(err, { stream: stream.name, tenant });
        return;
      }
      cursor = {
        seq: lastSeq,
        ...(checkpointId ? { checkpointId } : {}),
        failures: 0,
        lastDeliveredAt: items.length > 0 ? new Date(now()).toISOString() : cursor.lastDeliveredAt,
      } as StreamCursor;
      if (cursor.lastDeliveredAt === undefined) delete cursor.lastDeliveredAt;
      await storage.setItem(streamCursorKey(stream.name, tenant), cursor);
      if (events.length < batchSize) return;
    }
  }

  async function tick(): Promise<void> {
    if (running) return running;
    running = (async () => {
      for (const stream of options.streams) {
        if (!(await acquireLease(stream))) continue;
        await ensureStarted(stream);
        for (const tenant of await tenantsFor(stream)) {
          try {
            await pumpTenant(stream, tenant);
          } catch (err) {
            onError(err, { stream: stream.name, tenant });
          }
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  // Retention must not prune what a stream has not delivered (ADR 0008).
  const floor = async (tenant: string): Promise<number | null> => {
    let min: number | null = null;
    for (const stream of options.streams) {
      if (stream.tenants && !stream.tenants.includes(tenant)) continue;
      const c = await storage.getItem<StreamCursor>(streamCursorKey(stream.name, tenant));
      if (c) min = min === null ? c.seq : Math.min(min, c.seq);
    }
    return min;
  };
  const unregisterFloor = core.addRetentionFloor(floor);

  return {
    streams: options.streams,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      (timer as { unref?: () => void }).unref?.();
      void tick();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unregisterFloor();
      await running;
      for (const s of options.streams) await s.sink.close?.();
    },
    tick,
    async status() {
      const out: StreamStatus[] = [];
      for (const stream of options.streams) {
        const tenants: StreamStatus["tenants"] = [];
        for (const tenant of await tenantsFor(stream)) {
          const c = await storage.getItem<StreamCursor>(streamCursorKey(stream.name, tenant));
          const head = await core.head(tenant);
          const cursor = c?.seq ?? head.seq;
          tenants.push({
            tenant,
            cursor,
            headSeq: head.seq,
            lag: Math.max(0, head.seq - cursor),
            failures: c?.failures ?? 0,
            ...(c?.lastError ? { lastError: c.lastError } : {}),
            ...(c?.lastErrorAt ? { lastErrorAt: c.lastErrorAt } : {}),
            ...(c?.nextAttemptAt ? { nextAttemptAt: c.nextAttemptAt } : {}),
            ...(c?.lastDeliveredAt ? { lastDeliveredAt: c.lastDeliveredAt } : {}),
          });
        }
        out.push({ name: stream.name, kind: stream.sink.kind, tenants });
      }
      return out;
    },
    async retry(name, tenant) {
      const stream = options.streams.find((s) => s.name === name);
      if (!stream) return;
      for (const t of tenant ? [tenant] : await tenantsFor(stream)) {
        const c = await storage.getItem<StreamCursor>(streamCursorKey(name, t));
        if (c?.nextAttemptAt) {
          const { nextAttemptAt: _n, ...rest } = c;
          await storage.setItem(streamCursorKey(name, t), rest);
        }
      }
    },
  };
}

/** A sink that calls your function (tests, custom destinations). */
export function callbackSink(
  send: (batch: StreamBatch) => void | Promise<void>,
  kind = "callback",
): AuditSink {
  return { kind, send: async (batch) => void (await send(batch)) };
}
