/**
 * Postgres storage adapter: a key/value table (`key text PRIMARY KEY, value
 * jsonb`) for control data plus the **native event log** (ADR 0005) in
 * `{table}_events` / `{table}_event_targets` (see {@link ./sql}). It works with
 * any client exposing a `query(text, params?)` method that resolves to
 * `{ rows }` — this covers [`pg`](https://github.com/brianc/node-postgres)
 * (`Pool`/`Client`) and the in-process
 * [`@electric-sql/pglite`](https://github.com/electric-sql/pglite) alike. You
 * can pass a pre-built `client`, or a `connectionString`/`url` to lazily create
 * a `pg` `Pool` on first use.
 *
 * The KV part is `@xtandard/kit/storage/postgres`; the event log runs on the
 * same connection (`pgConnection` + `pgReady` from its `internals`). The tables
 * are created on demand (`CREATE TABLE IF NOT EXISTS`) the first time any
 * operation runs, once; a failed DDL is retried on the next call. The KV table
 * of a new database gets `key text COLLATE "C"`; existing tables keep working.
 * KV values are `jsonb`, written as canonical JSON, and `compareAndSwap` is one
 * statement.
 *
 * Every event-log write is a **single statement** (data-modifying CTEs), so it
 * is atomic without a transaction — which keeps the adapter correct on a `pg`
 * `Pool`, where consecutive queries may run on different connections. An
 * append inserts only when the tenant's max seq is the expected one, and the
 * `(tenant, seq)` primary key turns a concurrent writer's race into a
 * {@link ChainConflictError}.
 *
 * @module
 */

import type { CompareAndSwapKvStorage } from "@xtandard/kit/storage";
import * as kit from "@xtandard/kit/storage/postgres";
import {
  pgConnection,
  pgReady,
  postgresKvStorage,
  postgresStorageSchema,
} from "@xtandard/kit/storage/postgres/internals";
import { ChainConflictError, type EventLogStorage } from "./contract.ts";
import {
  assertContiguous,
  assertSafeIdentifier,
  compileEventQuery,
  eventColumns,
  eventLogDdl,
  eventTableNames,
  eventTargets,
  isWriteConflict,
  parseEvent,
  toQueryResult,
} from "./sql.ts";

export type { SqlClient } from "@xtandard/kit/storage/postgres";

/**
 * Options for {@link createPostgresStorage}: a `client` (`pg` `Pool`/`Client`,
 * `PGlite`) or a `connectionString`/`url`, and the KV `table` (default
 * `"xtandard_audit"`); the event log uses `{table}_events` and
 * `{table}_event_targets`. Must be a safe SQL identifier.
 */
export type PostgresStorageOptions = kit.PostgresStorageOptions;

/**
 * A storage backed by Postgres with the native {@link EventLogStorage}
 * capability and `compareAndSwap`, plus a `close()` method that ends the
 * underlying pool — but only the one this adapter created. A client you passed
 * in is left for you to manage.
 */
export interface PostgresAuditStorage extends EventLogStorage, CompareAndSwapKvStorage {
  /** End the underlying pool if this adapter created it. No-op otherwise. */
  close(): Promise<void>;
}

/** `jsonb_to_recordset` column list for event rows. */
const EVENT_RECORD = `r(tenant text, seq bigint, id text, action text, occurred_at text,
  recorded_at text, actor_id text, actor_type text, outcome text, search text, data jsonb)`;
const EVENT_COLUMNS = `tenant, seq, id, action, occurred_at, recorded_at, actor_id, actor_type,
  outcome, search, data`;

/**
 * Create a Postgres-backed {@link PostgresAuditStorage}. The tables are created
 * lazily on first use; connection (when using `connectionString`/`url`) is also
 * lazy — the `pg` `Pool` is imported and constructed on the first operation and
 * reused thereafter.
 *
 * @example
 * ```ts
 * import { createPostgresStorage } from "@xtandard/audit/storage/postgres";
 *
 * // Via connection string (lazy `pg` Pool):
 * const storage = createPostgresStorage({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * // Or with a pre-built pg Pool / PGlite client:
 * // import { PGlite } from "@electric-sql/pglite";
 * // const storage = createPostgresStorage({ client: new PGlite() });
 * ```
 */
export function createPostgresStorage(options: PostgresStorageOptions = {}): PostgresAuditStorage {
  const table = assertSafeIdentifier(options.table ?? "xtandard_audit");
  const names = eventTableNames(table);
  const { events: ev, targets: tg } = names;
  const connection = pgConnection(
    options.client,
    options.connectionString ?? options.url,
    options.subpath ?? "@xtandard/audit/storage/postgres",
  );
  const ready = pgReady(connection, [
    postgresStorageSchema(table),
    ...eventLogDdl("postgres", table),
  ]);

  const rows = async (text: string, params: unknown[]) =>
    (await (await ready()).query(text, params)).rows;

  const one = async (text: string, params: unknown[]) => {
    const [row] = await rows(text, params);
    return row ? parseEvent(row.data) : null;
  };

  return {
    ...postgresKvStorage(table, ready),

    // ---- native event log --------------------------------------------------------------------

    async appendEvents(tenant, events, { expectedSeq }): Promise<void> {
      if (events.length === 0) return;
      assertContiguous(tenant, events, expectedSeq);
      const eventRows = events.map((e) => {
        const c = eventColumns(e);
        return {
          tenant: c.tenant,
          seq: c.seq,
          id: c.id,
          action: c.action,
          occurred_at: c.occurredAt,
          recorded_at: c.recordedAt,
          actor_id: c.actorId,
          actor_type: c.actorType,
          outcome: c.outcome,
          search: c.search,
          data: e,
        };
      });
      const targetRows = events.flatMap((e) =>
        eventTargets(e).map((t) => ({ seq: e.seq, type: t.type, target_id: t.targetId })),
      );
      let inserted: number;
      try {
        const [row] = await rows(
          `WITH head AS (
             SELECT COALESCE(MAX(seq), 0) AS seq FROM ${ev} WHERE tenant = $1
           ), ok AS (
             SELECT 1 FROM head WHERE head.seq = $2 OR head.seq = 0
           ), ins AS (
             INSERT INTO ${ev} (${EVENT_COLUMNS})
             SELECT ${EVENT_COLUMNS} FROM jsonb_to_recordset($3::jsonb) AS ${EVENT_RECORD}
             WHERE EXISTS (SELECT 1 FROM ok)
             RETURNING seq
           ), tgt AS (
             INSERT INTO ${tg} (tenant, seq, type, target_id)
             SELECT $1, r.seq, r.type, r.target_id
             FROM jsonb_to_recordset($4::jsonb) AS r(seq bigint, type text, target_id text)
             WHERE EXISTS (SELECT 1 FROM ok)
           )
           SELECT COUNT(*) AS n FROM ins`,
          [tenant, expectedSeq, JSON.stringify(eventRows), JSON.stringify(targetRows)],
        );
        inserted = Number(row?.n ?? 0);
      } catch (err) {
        if (isWriteConflict(err)) throw new ChainConflictError(tenant, expectedSeq);
        throw err;
      }
      if (inserted !== events.length) throw new ChainConflictError(tenant, expectedSeq);
    },

    getEvent: (tenant, id) =>
      one(`SELECT data FROM ${ev} WHERE tenant = $1 AND id = $2`, [tenant, id]),

    lastEvent: (tenant) =>
      one(`SELECT data FROM ${ev} WHERE tenant = $1 ORDER BY seq DESC LIMIT 1`, [tenant]),

    async eventsBySeq(tenant, { afterSeq, limit }) {
      const found = await rows(
        `SELECT data FROM ${ev} WHERE tenant = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
        [tenant, afterSeq, limit],
      );
      return found.map((r) => parseEvent(r.data));
    },

    async queryEvents(q) {
      const { sql, args } = compileEventQuery("postgres", names, q);
      return toQueryResult(await rows(sql, args), q.limit);
    },

    async replaceEvent(event): Promise<void> {
      const c = eventColumns(event);
      const targets = eventTargets(event).map((t) => ({ type: t.type, target_id: t.targetId }));
      // One statement: the UPDATE gates the target rewrite (same tenant/seq/id only).
      await rows(
        `WITH upd AS (
           UPDATE ${ev} SET action = $4, occurred_at = $5, recorded_at = $6, actor_id = $7,
             actor_type = $8, outcome = $9, search = $10, data = $11::jsonb
           WHERE tenant = $1 AND seq = $2 AND id = $3
           RETURNING tenant, seq
         ), del AS (
           DELETE FROM ${tg} t USING upd WHERE t.tenant = upd.tenant AND t.seq = upd.seq
         ), ins AS (
           INSERT INTO ${tg} (tenant, seq, type, target_id)
           SELECT upd.tenant, upd.seq, r.type, r.target_id
           FROM upd, jsonb_to_recordset($12::jsonb) AS r(type text, target_id text)
         )
         SELECT COUNT(*) AS n FROM upd`,
        [
          c.tenant,
          c.seq,
          c.id,
          c.action,
          c.occurredAt,
          c.recordedAt,
          c.actorId,
          c.actorType,
          c.outcome,
          c.search,
          JSON.stringify(event),
          JSON.stringify(targets),
        ],
      );
    },

    async deleteEventsThrough(tenant, throughSeq) {
      const [row] = await rows(
        `WITH d AS (
           DELETE FROM ${ev} WHERE tenant = $1 AND seq <= $2 RETURNING 1
         ), dt AS (
           DELETE FROM ${tg} WHERE tenant = $1 AND seq <= $2
         )
         SELECT COUNT(*) AS n FROM d`,
        [tenant, throughSeq],
      );
      return Number(row?.n ?? 0);
    },

    async countEvents(tenant) {
      const [row] =
        tenant !== undefined
          ? await rows(`SELECT COUNT(*) AS n FROM ${ev} WHERE tenant = $1`, [tenant])
          : await rows(`SELECT COUNT(*) AS n FROM ${ev}`, []);
      return Number(row?.n ?? 0);
    },

    async listEventTenants() {
      const found = await rows(`SELECT DISTINCT tenant FROM ${ev} ORDER BY tenant`, []);
      return found.map((r) => String(r.tenant));
    },

    close: connection.close,
  } satisfies PostgresAuditStorage;
}
