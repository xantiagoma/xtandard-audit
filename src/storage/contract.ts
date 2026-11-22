/**
 * Storage contracts. The base {@link AuditStorage} is intentionally tiny —
 * four async methods — so users can bring their own backend. Optional
 * capabilities (watch, compare-and-swap, and the audit-specific native event
 * log) are separate interfaces that adapters may implement and the core
 * feature-detects (ADR 0005).
 *
 * The neutral contract lives in `@xtandard/kit/storage`; these are the audit
 * names for it, plus the audit-only {@link EventLogStorage}.
 *
 * @module
 */

import { requirePeer as kitRequirePeer, type KvStorage } from "@xtandard/kit/storage";
import type { AuditEvent } from "../schema.ts";
import type { NormalizedQuery } from "../query.ts";

export type {
  CompareAndSwapKvStorage as CompareAndSwapAuditStorage,
  KvStorage as AuditStorage,
  StorageChangeEvent,
  TransactionalKvStorage as TransactionalAuditStorage,
  WatchableKvStorage as WatchableAuditStorage,
} from "@xtandard/kit/storage";
export { isCompareAndSwap, isTransactional, isWatchable } from "@xtandard/kit/storage";

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
export interface EventLogStorage extends KvStorage {
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

/** Runtime feature-detection: does this storage implement the native event log? */
export function hasEventLog(storage: KvStorage): storage is EventLogStorage {
  return typeof (storage as Partial<EventLogStorage>).appendEvents === "function";
}

/**
 * Helper for adapters whose subpath requires an optional peer dependency. Throws
 * a clear, actionable error when the peer is missing.
 */
export function requirePeer(name: string, subpath: string): never {
  return kitRequirePeer(name, `@xtandard/audit/${subpath}`);
}
