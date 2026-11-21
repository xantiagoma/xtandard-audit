/**
 * In-memory storage adapter. Zero deps. Useful for tests, dev, and the demo.
 * Values are deep-cloned on write and read so callers cannot mutate stored
 * state by reference. Implements every optional capability: `watch`,
 * `compareAndSwap`, and the native event log (ADR 0005).
 *
 * @module
 */

import { applyQuery, type NormalizedQuery } from "../query.ts";
import type { AuditEvent } from "../schema.ts";
import {
  ChainConflictError,
  type CompareAndSwapAuditStorage,
  type EventLogStorage,
  type StorageChangeEvent,
  type WatchableAuditStorage,
  type AuditStorage,
} from "./contract.ts";

/** Options for {@link createMemoryStorage}. */
export interface MemoryStorageOptions {
  /** Optional seed data (key → value). */
  initial?: Record<string, unknown>;
}

/** The full capability set the memory adapter implements. */
export type MemoryAuditStorage = WatchableAuditStorage &
  CompareAndSwapAuditStorage &
  EventLogStorage;

const clone = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Create an in-memory {@link AuditStorage} with every optional capability.
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
  const map = new Map<string, unknown>();
  if (options.initial) {
    for (const [k, val] of Object.entries(options.initial)) map.set(k, clone(val));
  }

  // Native event log: per-tenant arrays ordered by seq, plus an id → seq index.
  const logs = new Map<string, AuditEvent[]>();
  const ids = new Map<string, number>();
  // Highest pruned seq per tenant, so appends after a full prune continue the chain.
  const baseSeqs = new Map<string, number>();

  const watchers = new Set<{ prefix: string; cb: (event: StorageChangeEvent) => void }>();
  const notify = (event: StorageChangeEvent) => {
    for (const w of watchers) {
      if (event.key.startsWith(w.prefix)) queueMicrotask(() => w.cb(event));
    }
  };

  const set = (key: string, value: unknown) => {
    map.set(key, clone(value));
    notify({ type: "update", key });
  };
  const remove = (key: string) => {
    if (map.delete(key)) notify({ type: "remove", key });
  };

  return {
    async getItem<T>(key: string): Promise<T | null> {
      return map.has(key) ? clone(map.get(key) as T) : null;
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      set(key, value);
    },
    async removeItem(key: string): Promise<void> {
      remove(key);
    },
    async getKeys(prefix: string): Promise<string[]> {
      const out: string[] = [];
      for (const k of map.keys()) if (k.startsWith(prefix)) out.push(k);
      return out;
    },
    async watch(prefix, cb): Promise<() => void> {
      const entry = { prefix, cb };
      watchers.add(entry);
      return () => {
        watchers.delete(entry);
      };
    },
    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      const current = map.has(input.key) ? map.get(input.key) : null;
      if (!deepEqual(current, input.expected)) return false;
      set(input.key, input.next);
      return true;
    },
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
  } satisfies AuditStorage & MemoryAuditStorage;
}
