/**
 * Storage contracts. The base {@link AuditStorage} is intentionally tiny —
 * four async methods — so users can bring their own backend. Optional
 * capabilities (watch, transactions, compare-and-swap, and the audit-specific
 * native event log) are separate interfaces that adapters may implement and the
 * core feature-detects (ADR 0005).
 *
 * @module
 */

import type { AuditEvent } from "../schema.ts";
import type { NormalizedQuery } from "../query.ts";

/** The minimal key/value contract every storage backend must satisfy. */
export interface AuditStorage {
  /** Read a value, or `null` if absent. */
  getItem<T>(key: string): Promise<T | null>;
  /** Write a value (overwriting any existing). */
  setItem<T>(key: string, value: T): Promise<void>;
  /** Delete a key (no-op if absent). */
  removeItem(key: string): Promise<void>;
  /** List all keys beginning with `prefix`. */
  getKeys(prefix: string): Promise<string[]>;
}

/** A storage change event delivered to {@link WatchableAuditStorage.watch} callbacks. */
export interface StorageChangeEvent {
  type: "update" | "remove";
  key: string;
}

/** Storage that can push change notifications (e.g. Redis pub/sub, fs.watch). */
export interface WatchableAuditStorage extends AuditStorage {
  /**
   * Subscribe to changes under `prefix`. Resolves to an unsubscribe function.
   */
  watch(prefix: string, callback: (event: StorageChangeEvent) => void): Promise<() => void>;
}

/** Storage that supports atomic multi-key transactions. */
export interface TransactionalAuditStorage extends AuditStorage {
  transaction<T>(callback: (tx: AuditStorage) => Promise<T>): Promise<T>;
}

/** Storage that supports optimistic concurrency via compare-and-swap. */
export interface CompareAndSwapAuditStorage extends AuditStorage {
  compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean>;
}

/**
 * Thrown by {@link EventLogStorage.appendEvents} when the tenant's chain moved
 * underneath the writer (another process appended first). The core re-reads the
 * head, re-chains the batch, and retries.
 */
export class ChainConflictError extends Error {
  constructor(tenant: string, expectedSeq: number) {
    super(`Chain conflict for tenant "${tenant}": expected head seq ${expectedSeq}`);
    this.name = "ChainConflictError";
  }
}

/**
 * Storage that stores and queries audit events **natively** (indexes, SQL
 * `WHERE`, Mongo filters) instead of through the generic KV index fallback in
 * the core (ADR 0005). Control data (catalog, heads, checkpoints, cursors) still
 * lives in the KV methods.
 *
 * Contract:
 * - `appendEvents` is atomic per call: either every event is stored or none,
 *   and it throws {@link ChainConflictError} when an event with the same
 *   `(tenant, seq)` exists or the tenant's last seq is not `expectedSeq`.
 * - `queryEvents` honours every {@link NormalizedQuery} filter, sorts by
 *   `(occurredAt, id)` in `query.order`, starts strictly after `query.after`,
 *   and returns at most `query.limit` items plus whether more exist.
 */
export interface EventLogStorage extends AuditStorage {
  appendEvents(
    tenant: string,
    events: AuditEvent[],
    options: { expectedSeq: number },
  ): Promise<void>;
  getEvent(tenant: string, id: string): Promise<AuditEvent | null>;
  /** The event with the highest seq for the tenant, or null. */
  lastEvent(tenant: string): Promise<AuditEvent | null>;
  /** Events with `seq > afterSeq` ascending by seq, at most `limit`. */
  eventsBySeq(tenant: string, options: { afterSeq: number; limit: number }): Promise<AuditEvent[]>;
  queryEvents(query: NormalizedQuery): Promise<{ items: AuditEvent[]; hasMore: boolean }>;
  /** Replace a stored event in place (same tenant/id/seq) — used by erasure. */
  replaceEvent(event: AuditEvent): Promise<void>;
  /** Delete every event of the tenant with `seq <= throughSeq`; resolves to the count removed. */
  deleteEventsThrough(tenant: string, throughSeq: number): Promise<number>;
  /** Count retained events (all tenants when `tenant` is omitted). */
  countEvents(tenant?: string): Promise<number>;
  /** Distinct tenants that have events. */
  listEventTenants(): Promise<string[]>;
}

/** Runtime feature-detection: does this storage implement `watch`? */
export function isWatchable(storage: AuditStorage): storage is WatchableAuditStorage {
  return typeof (storage as Partial<WatchableAuditStorage>).watch === "function";
}

/** Runtime feature-detection: does this storage implement `transaction`? */
export function isTransactional(storage: AuditStorage): storage is TransactionalAuditStorage {
  return typeof (storage as Partial<TransactionalAuditStorage>).transaction === "function";
}

/** Runtime feature-detection: does this storage implement `compareAndSwap`? */
export function isCompareAndSwap(storage: AuditStorage): storage is CompareAndSwapAuditStorage {
  return typeof (storage as Partial<CompareAndSwapAuditStorage>).compareAndSwap === "function";
}

/** Runtime feature-detection: does this storage implement the native event log? */
export function hasEventLog(storage: AuditStorage): storage is EventLogStorage {
  return typeof (storage as Partial<EventLogStorage>).appendEvents === "function";
}

/**
 * Helper for adapters whose subpath requires an optional peer dependency. Throws
 * a clear, actionable error when the peer is missing.
 */
export function requirePeer(name: string, subpath: string): never {
  throw new Error(
    `@xtandard/audit/${subpath} requires the "${name}" package. Install it with: bun add ${name}`,
  );
}
