/**
 * `@xtandard/audit/drizzle/mysql` — MySQL Drizzle table factories for the
 * audit store: the KV table plus the native event-log tables. Schema-only
 * (imports just `drizzle-orm/mysql-core`).
 *
 * - {@link mysqlAuditTable} — KV: `key varchar PRIMARY KEY` (length
 *   configurable), `value json NOT NULL`; `extraColumns`/`extraIndexes` mirror
 *   `drizzle-audit`.
 * - {@link mysqlAuditEventsTable} / {@link mysqlAuditEventTargetsTable} — the
 *   events and their targets, with the indexes the native query uses.
 * - {@link mysqlAuditTables} — all three with matching names, in one call.
 *
 * String key/filter columns use the **`utf8mb4_bin`** collation: MySQL's
 * default collations are case- and accent-insensitive, which would merge keys
 * like `aud/t/Acme/…` and `aud/t/acme/…` and make filters disagree with the
 * in-memory matcher. Lengths keep every index under InnoDB's 3072-byte limit
 * (they cover the core's validation limits: tenant/action 128, ids 256).
 *
 * @example
 * ```ts
 * import { mysqlAuditTables } from "@xtandard/audit/drizzle/mysql";
 * export const {
 *   table: auditKv,
 *   events: auditEvents,
 *   eventTargets: auditEventTargets,
 * } = mysqlAuditTables();
 * ```
 *
 * @module
 */

import {
  binVarchar,
  mysqlKvTable,
  type MysqlKeyCollation,
  type MysqlKvColumns,
} from "@xtandard/kit/drizzle/mysql";
import {
  bigint,
  customType,
  index,
  json,
  mysqlTable,
  primaryKey,
  unique,
  varchar,
  type MySqlColumnBuilderBase,
  type MySqlTableExtraConfigValue,
} from "drizzle-orm/mysql-core";
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

/** The `self` passed to an {@link MysqlAuditTableOptions.extraIndexes} callback. */
type MysqlAuditColumns = MysqlKvColumns;

/** Options for {@link mysqlAuditTable}. */
export interface MysqlAuditTableOptions {
  /**
   * `varchar` length for the `key` primary key. Default `512` (store keys are
   * short slash-delimited paths). Keep within your InnoDB index-prefix limit.
   */
  keyLength?: number;
  /**
   * Collation of the `key` column. Default `"utf8mb4_bin"` (what every release
   * declared, so drizzle-kit generates no `ALTER`). It is PAD SPACE: keys that
   * differ only by trailing spaces collide, which the storage turns into a
   * `KeyCollisionError`. New tables can use `"utf8mb4_0900_bin"` (MySQL 8.0+)
   * or `"utf8mb4_nopad_bin"` (MariaDB). Audit keys never end in a space (every
   * segment is URI-encoded), so the default is safe.
   */
  keyCollation?: MysqlKeyCollation;
  /** Additional columns merged into the table. */
  extraColumns?: () => Record<string, MySqlColumnBuilderBase>;
  /** Additional indexes/constraints; receives the built table for column references. */
  extraIndexes?: (table: MysqlAuditColumns) => MySqlTableExtraConfigValue[];
}

/** A `utf8mb4_bin` `longtext` (the lower-cased search haystack). */
const binLongtext = customType<{ data: string }>({
  dataType: () => `longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
});

/**
 * Build the MySQL `mysqlTable` for the audit KV store: `key varchar PRIMARY
 * KEY` (`utf8mb4_bin`), `value json NOT NULL`. The table name defaults to
 * `"xtandard_audit"`.
 */
export function mysqlAuditTable(
  name = "xtandard_audit",
  opts?: MysqlAuditTableOptions,
): DrizzleKvTable {
  return mysqlKvTable(name, { keyCollation: "utf8mb4_bin", ...opts });
}

/**
 * Build the events table: `PRIMARY KEY (tenant, seq)`, `UNIQUE (tenant, id)`
 * and `(tenant, occurred_at, id)` / `(tenant, actor_id, …)` / `(tenant, action,
 * …)` indexes. The name defaults to `"xtandard_audit_events"`.
 */
export function mysqlAuditEventsTable(name = "xtandard_audit_events"): DrizzleEventsTable {
  return mysqlTable(
    name,
    {
      tenant: binVarchar("tenant", 128).notNull(),
      seq: bigint("seq", { mode: "number" }).notNull(),
      id: binVarchar("id", 96).notNull(),
      action: binVarchar("action", 128).notNull(),
      occurredAt: binVarchar("occurred_at", 32).notNull(),
      recordedAt: varchar("recorded_at", { length: 32 }).notNull(),
      actorId: binVarchar("actor_id", 256).notNull(),
      actorType: binVarchar("actor_type", 64).notNull(),
      outcome: varchar("outcome", { length: 16 }),
      search: binLongtext("search").notNull(),
      data: json("data").notNull(),
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
export function mysqlAuditEventTargetsTable(
  name = "xtandard_audit_event_targets",
): DrizzleEventTargetsTable {
  return mysqlTable(
    name,
    {
      tenant: binVarchar("tenant", 128).notNull(),
      seq: bigint("seq", { mode: "number" }).notNull(),
      type: binVarchar("type", 64).notNull(),
      targetId: binVarchar("target_id", 256).notNull(),
    },
    (t) => [
      index(`${name}_target_idx`).on(t.tenant, t.type, t.targetId, t.seq),
      index(`${name}_seq_idx`).on(t.tenant, t.seq),
    ],
  );
}

/** All three tables with matching names: `{name}`, `{name}_events`, `{name}_event_targets`. */
export function mysqlAuditTables(
  name = "xtandard_audit",
  opts?: Pick<MysqlAuditTableOptions, "keyLength" | "keyCollation">,
): DrizzleAuditTables {
  return {
    table: mysqlAuditTable(name, opts),
    events: mysqlAuditEventsTable(`${name}_events`),
    eventTargets: mysqlAuditEventTargetsTable(`${name}_event_targets`),
  };
}
