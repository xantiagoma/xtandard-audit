/**
 * `@xtandard/audit/drizzle/sqlite` — SQLite Drizzle table factories for the
 * audit store: the KV table plus the native event-log tables. Schema-only
 * (imports just `drizzle-orm/sqlite-core`).
 *
 * - {@link sqliteAuditTable} — KV: `key text PRIMARY KEY`, `value text NOT
 *   NULL` in JSON mode (Drizzle serializes/parses transparently);
 *   `extraColumns`/`extraIndexes` mirror `drizzle-audit`.
 * - {@link sqliteAuditEventsTable} / {@link sqliteAuditEventTargetsTable} — the
 *   events and their targets, with the indexes the native query uses.
 * - {@link sqliteAuditTables} — all three with matching names, in one call.
 *
 * The same columns as `createSqliteStorage` / `createLibsqlStorage` create.
 *
 * @example
 * ```ts
 * import { sqliteAuditTables } from "@xtandard/audit/drizzle/sqlite";
 * export const {
 *   table: auditKv,
 *   events: auditEvents,
 *   eventTargets: auditEventTargets,
 * } = sqliteAuditTables();
 * ```
 *
 * @module
 */

import { sqliteKvTable, type SqliteKvColumns } from "@xtandard/kit/drizzle/sqlite";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  type SQLiteColumnBuilderBase,
  type SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";
import type {
  DrizzleAuditTables,
  DrizzleEventTargetsTable,
  DrizzleEventsTable,
  DrizzleKvTable,
} from "./table.ts";

export type {
  DrizzleAuditTables,
  DrizzleEventTargetsTable,
  DrizzleEventsTable,
  DrizzleKvTable,
} from "./table.ts";

/** The `self` passed to an {@link SqliteAuditTableOptions.extraIndexes} callback. */
type SqliteAuditColumns = SqliteKvColumns;

/** Options for {@link sqliteAuditTable}. */
export interface SqliteAuditTableOptions {
  /** Additional columns merged into the table. */
  extraColumns?: () => Record<string, SQLiteColumnBuilderBase>;
  /** Additional indexes/constraints; receives the built table for column references. */
  extraIndexes?: (table: SqliteAuditColumns) => SQLiteTableExtraConfigValue[];
}

/**
 * Build the SQLite `sqliteTable` for the audit KV store: `key text PRIMARY
 * KEY`, `value text NOT NULL` (JSON mode). The table name defaults to
 * `"xtandard_audit"`.
 */
export function sqliteAuditTable(
  name = "xtandard_audit",
  opts?: SqliteAuditTableOptions,
): DrizzleKvTable {
  return sqliteKvTable(name, opts);
}

/**
 * Build the events table: `PRIMARY KEY (tenant, seq)`, `UNIQUE (tenant, id)`
 * and `(tenant, occurred_at, id)` / `(tenant, actor_id, …)` / `(tenant, action,
 * …)` indexes. The name defaults to `"xtandard_audit_events"`.
 */
export function sqliteAuditEventsTable(name = "xtandard_audit_events"): DrizzleEventsTable {
  return sqliteTable(
    name,
    {
      tenant: text("tenant").notNull(),
      seq: integer("seq").notNull(),
      id: text("id").notNull(),
      action: text("action").notNull(),
      occurredAt: text("occurred_at").notNull(),
      recordedAt: text("recorded_at").notNull(),
      actorId: text("actor_id").notNull(),
      actorType: text("actor_type").notNull(),
      outcome: text("outcome"),
      search: text("search").notNull(),
      data: text("data", { mode: "json" }).notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.tenant, t.seq] }),
      unique(`${name}_tenant_id_key`).on(t.tenant, t.id),
      index(`${name}_time_idx`).on(t.tenant, t.occurredAt, t.id),
      index(`${name}_actor_idx`).on(t.tenant, t.actorId, t.occurredAt, t.id),
      index(`${name}_action_idx`).on(t.tenant, t.action, t.occurredAt, t.id),
    ],
  );
}

/**
 * Build the event-targets table (one row per distinct event target), indexed
 * on `(tenant, type, target_id, seq)` and `(tenant, seq)`. The name defaults to
 * `"xtandard_audit_event_targets"`.
 */
export function sqliteAuditEventTargetsTable(
  name = "xtandard_audit_event_targets",
): DrizzleEventTargetsTable {
  return sqliteTable(
    name,
    {
      tenant: text("tenant").notNull(),
      seq: integer("seq").notNull(),
      type: text("type").notNull(),
      targetId: text("target_id").notNull(),
    },
    (t) => [
      index(`${name}_target_idx`).on(t.tenant, t.type, t.targetId, t.seq),
      index(`${name}_seq_idx`).on(t.tenant, t.seq),
    ],
  );
}

/** All three tables with matching names: `{name}`, `{name}_events`, `{name}_event_targets`. */
export function sqliteAuditTables(name = "xtandard_audit"): DrizzleAuditTables {
  return {
    table: sqliteAuditTable(name),
    events: sqliteAuditEventsTable(`${name}_events`),
    eventTargets: sqliteAuditEventTargetsTable(`${name}_event_targets`),
  };
}
