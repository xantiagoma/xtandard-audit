/**
 * SQLite storage adapter built on `bun:sqlite` — **Bun only**, zero npm deps.
 * Ideal for single-node deployments and local/dev persistence: durable, fast, and
 * file-backed (or in-memory). For multi-node runtimes prefer Postgres/libSQL.
 *
 * Control data lives in a key/value table; events live in the **native event
 * log** tables `{table}_events` / `{table}_event_targets` (ADR 0005, see
 * {@link ./sql}), so queries run on indexes instead of KV scans. Event-log
 * writes run in `BEGIN IMMEDIATE` transactions, so several processes sharing
 * one database file stay consistent.
 *
 * `bun:sqlite` is marked external at build time, so this module only resolves
 * under the Bun runtime. Importing it under Node will throw — by design.
 *
 * ```ts
 * import { createSqliteStorage } from "@xtandard/audit/storage/sqlite";
 * const storage = createSqliteStorage({ path: "./audit.sqlite" });
 * ```
 *
 * @module
 */

import { Database } from "bun:sqlite";
import type { EventLogStorage } from "./contract.ts";
import { createSqliteEventLog, type SqliteExecutor } from "./sqlite-event-log.ts";
import { assertSafeIdentifier, eventLogDdl, type SqlStatement } from "./sql.ts";

/** Options for {@link createSqliteStorage}. */
export interface SqliteStorageOptions {
  /** File path for the database. Default `":memory:"`. Ignored when `database` is given. */
  path?: string;
  /** An existing `bun:sqlite` Database instance to use instead of opening one. */
  database?: Database;
  /**
   * KV table name (default `"xtandard_audit"`); the event log uses
   * `{table}_events` and `{table}_event_targets`. Validated as a safe identifier.
   */
  table?: string;
}

/** A storage backed by SQLite with the native {@link EventLogStorage}, plus `close()`. */
export interface SqliteAuditStorage extends EventLogStorage {
  /** Close the database if this adapter opened it; no-op for a borrowed instance. */
  close(): void;
}

const escapeLike = (prefix: string): string => prefix.replace(/[\\%_]/g, (c) => `\\${c}`);

type Binding = string | number | bigint | boolean | null | Uint8Array;

/**
 * Create a SQLite-backed storage. Requires the Bun runtime (`bun:sqlite`). The
 * tables are created (`IF NOT EXISTS`) when the adapter is constructed.
 *
 * @example
 * ```ts
 * import { createSqliteStorage } from "@xtandard/audit/storage/sqlite";
 *
 * // File-backed (persists across restarts):
 * const storage = createSqliteStorage({ path: "./audit.sqlite" });
 *
 * // In-memory (reset each run, useful for tests):
 * // const storage = createSqliteStorage({ path: ":memory:" });
 * ```
 */
export function createSqliteStorage(options: SqliteStorageOptions = {}): SqliteAuditStorage {
  const table = assertSafeIdentifier(options.table ?? "xtandard_audit");

  const ownsDb = !options.database;
  const db = options.database ?? new Database(options.path ?? ":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const ddl of eventLogDdl("sqlite", table)) db.run(ddl);

  const selectStmt = db.query(`SELECT value FROM ${table} WHERE key = ?`);
  const upsertStmt = db.query(
    `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteStmt = db.query(`DELETE FROM ${table} WHERE key = ?`);
  const keysStmt = db.query(`SELECT key FROM ${table} WHERE key LIKE ? ESCAPE '\\'`);

  // Synchronous under the hood: a transaction can never interleave with another call.
  const atomic = db.transaction((statements: SqlStatement[]) =>
    statements.map((s) => db.query(s.sql).run(...(s.args as Binding[])).changes),
  );
  const executor: SqliteExecutor = {
    async all(sql, args) {
      return db.query(sql).all(...(args as Binding[])) as Array<Record<string, unknown>>;
    },
    async atomic(statements) {
      return atomic.immediate(statements);
    },
  };
  const ready = Promise.resolve(executor);

  return {
    async getItem<T>(key: string): Promise<T | null> {
      const row = selectStmt.get(key) as { value: string } | null;
      return row ? (JSON.parse(row.value) as T) : null;
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      upsertStmt.run(key, JSON.stringify(value));
    },
    async removeItem(key: string): Promise<void> {
      deleteStmt.run(key);
    },
    async getKeys(prefix: string): Promise<string[]> {
      const rows = keysStmt.all(`${escapeLike(prefix)}%`) as Array<{ key: string }>;
      // SQLite LIKE folds ASCII case: keep only exact prefix matches.
      return rows.map((r) => r.key).filter((key) => key.startsWith(prefix));
    },
    ...createSqliteEventLog(() => ready, table),
    close(): void {
      if (ownsDb) db.close();
    },
  } satisfies SqliteAuditStorage;
}
