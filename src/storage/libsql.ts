/**
 * libSQL / [Turso](https://turso.tech) storage adapter built on the
 * [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts) package
 * (an optional peer dependency). It speaks the same SQL dialect as SQLite but
 * works against a **remote, replicated, edge-distributed** database — or a local
 * file / embedded replica — so it suits multi-node and edge runtimes where
 * `bun:sqlite` (single-file, Bun-only) does not.
 *
 * Control data lives in a key/value table (`@xtandard/kit/storage/libsql`:
 * canonical JSON, case-sensitive `GLOB` prefixes, `compareAndSwap`); events live
 * in the **native event log** tables `{table}_events` / `{table}_event_targets` (ADR 0005, see
 * {@link ./sql}). Every event-log write is one `batch(…, "write")` call — a
 * single round-trip that libSQL runs as one transaction. A failed connect or DDL
 * is retried on the next call.
 *
 * Pass either a pre-constructed `client`, or `url` (+ optional `authToken`) to let
 * the adapter construct one lazily on first use. An optional `prefix` is **not**
 * used here — keys are stored verbatim as the primary key; namespace via a
 * distinct `table` or a separate database instead.
 *
 * ```ts
 * import { createLibsqlStorage } from "@xtandard/audit/storage/libsql";
 *
 * // Turso (remote):
 * const storage = createLibsqlStorage({
 *   url: process.env.TURSO_DATABASE_URL!,    // libsql://<db>-<org>.turso.io
 *   authToken: process.env.TURSO_AUTH_TOKEN!,
 * });
 *
 * // Local file or embedded replica:
 * // const storage = createLibsqlStorage({ url: "file:audit.db" });
 * ```
 *
 * @module
 */

import type { CompareAndSwapKvStorage } from "@xtandard/kit/storage";
import type * as kit from "@xtandard/kit/storage/libsql";
import {
  libsqlConnection,
  libsqlExecutor,
  sqliteKvSchema,
  sqliteKvStorage,
} from "@xtandard/kit/storage/libsql/internals";
import type { EventLogStorage } from "./contract.ts";
import { createSqliteEventLog, type SqliteExecutor } from "./sqlite-event-log.ts";
import { assertSafeIdentifier, eventLogDdl } from "./sql.ts";

/** Options for {@link createLibsqlStorage}. */
export interface LibsqlStorageOptions extends Omit<kit.LibsqlStorageOptions, "client"> {
  /** A pre-constructed `@libsql/client` client to use instead of connecting. */
  client?: LibsqlClientLike;
  /**
   * KV table name (default `"xtandard_audit"`); the event log uses
   * `{table}_events` and `{table}_event_targets`. Validated as a safe identifier.
   */
  table?: string;
}

/**
 * A storage backed by libSQL/Turso with the native {@link EventLogStorage} and
 * `compareAndSwap`, plus `close()`.
 */
export interface LibsqlAuditStorage extends EventLogStorage, CompareAndSwapKvStorage {
  /** Close the client if this adapter created it; no-op for a borrowed instance. */
  close(): void;
}

/** One `@libsql/client` result set (the fields this adapter reads). */
export interface LibsqlResultLike {
  rows: Array<Record<string, unknown>>;
  rowsAffected?: number;
}

/**
 * Minimal structural view of the `@libsql/client` surface this adapter uses:
 * the kit's (`execute`, `close`) plus `batch`, which the event log needs.
 */
export interface LibsqlClientLike extends kit.LibsqlClientLike {
  execute(stmt: string | { sql: string; args: unknown[] }): Promise<LibsqlResultLike>;
  /** Run statements in one transaction (`"write"` mode); resolves to one result per statement. */
  batch(
    stmts: Array<{ sql: string; args: unknown[] }>,
    mode?: "write" | "read" | "deferred",
  ): Promise<LibsqlResultLike[]>;
  close(): void;
}

/**
 * Create a libSQL/Turso-backed {@link LibsqlAuditStorage}. The tables are
 * created on first use; connection (when constructed from `url`) is lazy and
 * shared.
 *
 * @example
 * ```ts
 * import { createLibsqlStorage } from "@xtandard/audit/storage/libsql";
 *
 * const storage = createLibsqlStorage({
 *   url: process.env.TURSO_DATABASE_URL!,
 *   authToken: process.env.TURSO_AUTH_TOKEN,
 * });
 * // process.on("SIGTERM", () => storage.close());
 * ```
 */
export function createLibsqlStorage(options: LibsqlStorageOptions): LibsqlAuditStorage {
  const table = assertSafeIdentifier(options.table ?? "xtandard_audit");
  const connection = libsqlConnection(
    options,
    [sqliteKvSchema(table), ...eventLogDdl("sqlite", table)],
    options.subpath ?? "@xtandard/audit/storage/libsql",
  );
  const exec = async (): Promise<SqliteExecutor> => {
    // A client created from `url` is a real `@libsql/client` client, which has `batch`.
    const client = (await connection.get()) as LibsqlClientLike;
    return {
      ...libsqlExecutor(client),
      async atomic(statements) {
        const results = await client.batch(statements, "write");
        return results.map((r) => r.rowsAffected ?? 0);
      },
    };
  };

  return {
    ...sqliteKvStorage(table, exec),
    ...createSqliteEventLog(exec, table),
    close: connection.close,
  } satisfies LibsqlAuditStorage;
}
