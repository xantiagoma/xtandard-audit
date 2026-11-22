/**
 * The table shapes the Drizzle storage adapter reads/writes, expressed with
 * the **stable, dialect-agnostic** root `drizzle-orm` types (`Table`/`Column`).
 *
 * The `*Audit*Table` factories annotate their return as these types on purpose:
 * returning the raw inferred `PgTableWithColumns<…>` would (a) freeze the
 * version-specific internal column brand into the emitted `.d.ts` — breaking
 * consumers on a different `drizzle-orm` (e.g. 1.0 beta, whose `Column` shape
 * differs) — and (b) not be nameable across the `schema`/no-`schema` union
 * (TS2883). These types use only public types and are all the adapter needs.
 *
 * @module
 */

import type { Column, Table } from "drizzle-orm";
import type { DrizzleKvTable } from "@xtandard/kit/drizzle/pg";

/** A table with the fixed `key`/`value` columns the audit KV store requires (the kit's shape). */
export type { DrizzleKvTable } from "@xtandard/kit/drizzle/pg";

/**
 * The native event-log table (`{name}_events`): one row per event, the full
 * event in `data` plus the denormalized columns queries filter and sort on.
 */
export type DrizzleEventsTable = Table & {
  tenant: Column;
  seq: Column;
  id: Column;
  action: Column;
  occurredAt: Column;
  recordedAt: Column;
  actorId: Column;
  actorType: Column;
  outcome: Column;
  search: Column;
  data: Column;
};

/** The event-targets table (`{name}_event_targets`): one row per distinct event target. */
export type DrizzleEventTargetsTable = Table & {
  tenant: Column;
  seq: Column;
  type: Column;
  targetId: Column;
};

/**
 * All three audit tables, as returned by `pgAuditTables()` / `mysqlAuditTables()` /
 * `sqliteAuditTables()`. The keys match `createDrizzleStorage`'s options, so
 * `createDrizzleStorage({ db, ...tables })` works.
 */
export interface DrizzleAuditTables {
  /** The KV table (control data: catalog, chain heads, checkpoints, cursors). */
  table: DrizzleKvTable;
  /** The events table. */
  events: DrizzleEventsTable;
  /** The event-targets table. */
  eventTargets: DrizzleEventTargetsTable;
}
