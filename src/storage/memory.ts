/**
 * In-memory storage adapter. Zero deps. Useful for tests, dev, and the demo.
 * Values are deep-cloned on write and read so callers cannot mutate stored
 * state by reference. Implements every optional capability: `watch`,
 * `compareAndSwap` (the `@xtandard/kit/storage/memory` driver), and the native
 * event log (ADR 0005).
 *
 * @module
 */

import type { CompareAndSwapKvStorage, WatchableKvStorage } from "@xtandard/kit/storage";
import * as kit from "@xtandard/kit/storage/memory";
import { applyQuery, type NormalizedQuery } from "../query.ts";
import type { AuditEvent } from "../schema.ts";
import { ChainConflictError, type EventLogStorage } from "./contract.ts";
import type { EventLogMethods } from "./sql.ts";

/** Options for {@link createMemoryStorage}: optional seed data (key → value) and an `onWrite` hook. */
export type MemoryStorageOptions = kit.MemoryStorageOptions;

/** The full capability set the memory adapter implements. */
export type MemoryAuditStorage = WatchableKvStorage & CompareAndSwapKvStorage & EventLogStorage;

const clone = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

/**
 * Create an in-memory {@link MemoryAuditStorage} with every optional capability.
 * `watch` fires callbacks on the next microtask after a write/remove;
 * `compareAndSwap` compares deep equality; events live in per-tenant arrays
 * ordered by seq (single-threaded JS makes append-with-conflict-check atomic
 * in-process).
 *
 * @example
 * ```ts
 * import { createMemoryStorage } from "@xtandard/audit/storage/memory";
 *
 * const storage = createMemoryStorage();
 * ```
 */
export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryAuditStorage {
  return { ...kit.createMemoryStorage(options), ...createMemoryEventLog() };
}

/** The native event log in per-tenant arrays ordered by seq. */
function createMemoryEventLog(): EventLogMethods {
  const logs = new Map<string, AuditEvent[]>();
  const ids = new Map<string, number>();
  const baseSeqs = new Map<string, number>();

  return {
    async appendEvents(tenant, events, { expectedSeq }): Promise<void> {
      const list = logs.get(tenant) ?? [];
      const last = list[list.length - 1]?.seq ?? baseSeqs.get(tenant) ?? 0;
      if (last !== expectedSeq) throw new ChainConflictError(tenant, expectedSeq);
      events.forEach((e, i) => {
        if (e.seq !== expectedSeq + i + 1) throw new ChainConflictError(tenant, expectedSeq);
      });
      for (const e of events) {
        list.push(clone(e));
        ids.set(`${tenant}\u0000${e.id}`, e.seq);
      }
      logs.set(tenant, list);
    },
    async getEvent(tenant, id): Promise<AuditEvent | null> {
      const seq = ids.get(`${tenant}\u0000${id}`);
      if (seq === undefined) return null;
      const found = (logs.get(tenant) ?? []).find((e) => e.seq === seq);
      return found ? clone(found) : null;
    },
    async lastEvent(tenant): Promise<AuditEvent | null> {
      const list = logs.get(tenant) ?? [];
      const last = list[list.length - 1];
      return last ? clone(last) : null;
    },
    async eventsBySeq(tenant, { afterSeq, limit }): Promise<AuditEvent[]> {
      const list = logs.get(tenant) ?? [];
      return list
        .filter((e) => e.seq > afterSeq)
        .slice(0, limit)
        .map(clone);
    },
    async queryEvents(query: NormalizedQuery) {
      const source =
        query.tenant !== undefined ? (logs.get(query.tenant) ?? []) : [...logs.values()].flat();
      const result = applyQuery(source, query);
      return { items: result.items.map(clone), hasMore: result.hasMore };
    },
    async replaceEvent(event): Promise<void> {
      const list = logs.get(event.tenant) ?? [];
      const idx = list.findIndex((e) => e.id === event.id && e.seq === event.seq);
      if (idx !== -1) list[idx] = clone(event);
    },
    async deleteEventsThrough(tenant, throughSeq): Promise<number> {
      const list = logs.get(tenant) ?? [];
      const keep = list.filter((e) => e.seq > throughSeq);
      for (const e of list) if (e.seq <= throughSeq) ids.delete(`${tenant}\u0000${e.id}`);
      logs.set(tenant, keep);
      const removed = list.length - keep.length;
      if (removed > 0) baseSeqs.set(tenant, Math.max(baseSeqs.get(tenant) ?? 0, throughSeq));
      return removed;
    },
    async countEvents(tenant): Promise<number> {
      if (tenant !== undefined) return (logs.get(tenant) ?? []).length;
      let n = 0;
      for (const list of logs.values()) n += list.length;
      return n;
    },
    async listEventTenants(): Promise<string[]> {
      return [...logs.keys()].filter((t) => (logs.get(t) ?? []).length > 0 || baseSeqs.has(t));
    },
  };
}
