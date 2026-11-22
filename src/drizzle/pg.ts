/**
 * `@xtandard/audit/drizzle/pg` — Drizzle table factories for the audit store:
 * the KV table plus the native event-log tables.
 *
 * Schema-only (imports just `drizzle-orm/pg-core`, never the audit core), so
 * it is safe to use inside a Drizzle schema file. Adding the tables to your
 * schema brings them into your normal `drizzle-kit` generate/migrate flow
 * instead of an adapter-side `CREATE TABLE`:
 *
 * - {@link pgAuditTable} — KV (`key text PRIMARY KEY`, `value jsonb NOT NULL`),
 *   the kit's `pgKvTable` with the plain `text` key every release declared (so
 *   drizzle-kit generates no `ALTER`); `extraColumns`/`extraIndexes` mirror the
 *   `drizzle-audit` factories.
 * - {@link pgAuditEventsTable} / {@link pgAuditEventTargetsTable} — the events
 *   and their targets, with the indexes the native query uses.
 * - {@link pgAuditTables} — all three with matching names, in one call.
 *
 * The same columns as `createPostgresStorage`'s lazily created tables, so a
 * database can move between the raw driver and Drizzle.
 *
 * @example
 * ```ts
 * // schema.ts — export each table so drizzle-kit picks it up
 * import { pgAuditTables } from "@xtandard/audit/drizzle/pg";
 * export const {
 *   table: auditKv,
 *   events: auditEvents,
 *   eventTargets: auditEventTargets,
 * } = pgAuditTables();
 *
 * // then: createDrizzleStorage({ db, table: auditKv, events: auditEvents, eventTargets: auditEventTargets })
 * ```
 *
 * @module
 */

import { pgKvTable, textC, type PgKvColumns } from "@xtandard/kit/drizzle/pg";
import {
  bigint,
  index,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  unique,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
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

/** The `self` passed to an {@link PgAuditTableOptions.extraIndexes} callback. */
type PgAuditColumns = PgKvColumns;

/** Options for {@link pgAuditTable}. */
export interface PgAuditTableOptions {
  /** Postgres schema (namespace) to place the table in. Defaults to the public schema. */
  schema?: string;
  /** Additional columns merged into the table (e.g. a tenant discriminator). */
  extraColumns?: () => Record<string, PgColumnBuilderBase>;
  /** Additional indexes/constraints; receives the built table for column references. */
  extraIndexes?: (table: PgAuditColumns) => PgTableExtraConfigValue[];
}

/** Options for the event-log table factories. */
export interface PgAuditEventTablesOptions {
  /** Postgres schema (namespace) to place the tables in. Defaults to the public schema. */
  schema?: string;
}

/** `pgTable`, or the schema-scoped equivalent (same call signature; only the schema brand differs). */
const tableIn = (schema: string | undefined) =>
  (schema ? pgSchema(schema).table : pgTable) as typeof pgTable;

/**
 * Build the Drizzle `pgTable` for the audit KV store. Base columns are fixed —
 * `key text PRIMARY KEY`, `value jsonb NOT NULL` — and required by
 * `createDrizzleStorage`; `schema`/`extraColumns`/`extraIndexes` extend it.
 * The table name defaults to `"xtandard_audit"`.
 */
export function pgAuditTable(name = "xtandard_audit", opts?: PgAuditTableOptions): DrizzleKvTable {
  return pgKvTable(name, { ...opts, keyCollation: null });
}

/**
 * Build the events table: `PRIMARY KEY (tenant, seq)`, `UNIQUE (tenant, id)`
 * and `(tenant, occurred_at, id)` / `(tenant, actor_id, …)` / `(tenant, action,
 * …)` indexes. The name defaults to `"xtandard_audit_events"`. `id`, `action`
 * and `occurred_at` are `text COLLATE "C"` (the kit's `textC`): bytewise
 * ordering and LIKE prefixes, so `(occurred_at, id)` sorts exactly like the
 * in-memory matcher whatever the database's default collation.
 */
export function pgAuditEventsTable(
  name = "xtandard_audit_events",
  opts?: PgAuditEventTablesOptions,
): DrizzleEventsTable {
  return tableIn(opts?.schema)(
    name,
    {
      tenant: text("tenant").notNull(),
      seq: bigint("seq", { mode: "number" }).notNull(),
      id: textC("id").notNull(),
      action: textC("action").notNull(),
      occurredAt: textC("occurred_at").notNull(),
      recordedAt: text("recorded_at").notNull(),
      actorId: text("actor_id").notNull(),
      actorType: text("actor_type").notNull(),
      outcome: text("outcome"),
      search: text("search").notNull(),
      data: jsonb("data").notNull(),
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
export function pgAuditEventTargetsTable(
  name = "xtandard_audit_event_targets",
  opts?: PgAuditEventTablesOptions,
): DrizzleEventTargetsTable {
  return tableIn(opts?.schema)(
    name,
    {
      tenant: text("tenant").notNull(),
      seq: bigint("seq", { mode: "number" }).notNull(),
      type: text("type").notNull(),
      targetId: text("target_id").notNull(),
    },
    (t) => [
      index(`${name}_target_idx`).on(t.tenant, t.type, t.targetId, t.seq),
      index(`${name}_seq_idx`).on(t.tenant, t.seq),
    ],
  );
}

/**
 * All three tables with matching names: `{name}`, `{name}_events`,
 * `{name}_event_targets` (the same layout `createPostgresStorage` creates).
 */
export function pgAuditTables(
  name = "xtandard_audit",
  opts?: PgAuditEventTablesOptions,
): DrizzleAuditTables {
  return {
    table: pgAuditTable(name, opts),
    events: pgAuditEventsTable(`${name}_events`, opts),
    eventTargets: pgAuditEventTargetsTable(`${name}_event_targets`, opts),
  };
}
