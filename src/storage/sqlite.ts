/**
 * SQLite storage adapter built on `bun:sqlite` — **Bun only**, zero npm deps.
 * Ideal for single-node deployments and local/dev persistence: durable, fast, and
 * file-backed (or in-memory). For multi-node runtimes prefer Postgres/libSQL.
 *
 * Control data lives in a key/value table (`@xtandard/kit/storage/sqlite`:
 * canonical JSON, case-sensitive `GLOB` prefixes, `compareAndSwap`); events live
 * in the **native event log** tables `{table}_events` / `{table}_event_targets`
 * (ADR 0005, see {@link ./sql}), so queries run on indexes instead of KV scans.
 * Event-log writes run in `BEGIN IMMEDIATE` transactions, so several processes
 * sharing one database file stay consistent.
 *
 * `bun:sqlite` is loaded on first use, so importing this module works under
 * Node; opening a database needs Bun. The tables are created on first use.
 *
 * ```ts
 * import { createSqliteStorage } from "@xtandard/audit/storage/sqlite";
 * const storage = createSqliteStorage({ path: "./audit.sqlite" });
 * ```
 *
 * @module
 */

import type { CompareAndSwapKvStorage } from "@xtandard/kit/storage";
import type * as kit from "@xtandard/kit/storage/sqlite";
import {
  bunSqliteExecutor,
  sqliteConnection,
  sqliteKvSchema,
  sqliteKvStorage,
} from "@xtandard/kit/storage/sqlite/internals";
import type { EventLogStorage } from "./contract.ts";
import { createSqliteEventLog, type SqliteExecutor } from "./sqlite-event-log.ts";
import { assertSafeIdentifier, eventLogDdl } from "./sql.ts";

/**
 * Options for {@link createSqliteStorage}: a file `path` (default `":memory:"`)
 * or an existing `database`, and the KV `table` (default `"xtandard_audit"`);
 * the event log uses `{table}_events` and `{table}_event_targets`. Validated as
 * a safe identifier.
 */
export type SqliteStorageOptions = kit.SqliteStorageOptions;

/**
 * A storage backed by SQLite with the native {@link EventLogStorage} and
 * `compareAndSwap`, plus `close()`.
 */
export interface SqliteAuditStorage extends EventLogStorage, CompareAndSwapKvStorage {
  /** Close the database if this adapter opened it; no-op for a borrowed instance. */
  close(): void;
}

/**
 * Create a SQLite-backed storage. Requires the Bun runtime (`bun:sqlite`) once
 * used. The tables are created (`IF NOT EXISTS`) on first use.
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
  const connection = sqliteConnection(
    options,
    [sqliteKvSchema(table), ...eventLogDdl("sqlite", table)],
    options.subpath ?? "@xtandard/audit/storage/sqlite",
  );
  let executor: Promise<SqliteExecutor> | undefined;
  const exec = () =>
    (executor ??= connection.get().then(
      // `BEGIN IMMEDIATE` write transactions for the event log's `atomic` appends.
      (db) => bunSqliteExecutor(db) as SqliteExecutor,
      (error: unknown) => {
        executor = undefined; // a failed open or DDL is retried on the next call
        throw error;
      },
    ));

  return {
    ...sqliteKvStorage(table, exec),
    ...createSqliteEventLog(exec, table),
    close: connection.close,
  } satisfies SqliteAuditStorage;
}
