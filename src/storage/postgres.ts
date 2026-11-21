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
 * The tables are created on demand (`CREATE TABLE IF NOT EXISTS`) the first
 * time any operation runs, guarded by a single promise so concurrent callers
 * only issue the DDL once. Values are stored as `jsonb`; both `pg` and `pglite`
 * return `jsonb` already parsed to JS, but a string is JSON-parsed defensively
 * so either driver works.
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

import { ChainConflictError, requirePeer } from "./contract.ts";
import type { EventLogStorage } from "./contract.ts";
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

/**
 * Minimal structural view of a SQL client. Both `pg`'s `Pool`/`Client` and
 * `@electric-sql/pglite`'s `PGlite` satisfy this shape.
 */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A client this adapter can also shut down (e.g. a `pg` `Pool`). */
interface ClosableSqlClient extends SqlClient {
  end?(): Promise<unknown>;
}

/** Options for {@link createPostgresStorage}. */
export interface PostgresStorageOptions {
  /**
   * A pre-built client exposing `query(text, params?) => Promise<{ rows }>`.
   * Both a `pg` `Pool`/`Client` and `@electric-sql/pglite` satisfy this.
   */
  client?: SqlClient;
  /**
   * Connection string used to lazily create a `pg` `Pool` (via dynamic import)
   * when no `client` is supplied.
   */
  connectionString?: string;
  /** Alias for {@link PostgresStorageOptions.connectionString}. */
  url?: string;
  /**
   * KV table name (default `"xtandard_audit"`); the event log uses
   * `{table}_events` and `{table}_event_targets`. Must be a safe SQL identifier.
   */
  table?: string;
}

/**
 * A storage backed by Postgres with the native
 * {@link EventLogStorage} capability, plus a `close()` method that ends the
 * underlying pool — but only the one this adapter created. A client you passed
 * in is left for you to manage.
 */
export interface PostgresAuditStorage extends EventLogStorage {
  /** End the underlying pool if this adapter created it. No-op otherwise. */
  close(): Promise<void>;
}

/**
 * Escape LIKE wildcards (`%`, `_`) and the escape char itself in a literal
 * prefix so `getKeys` matches the prefix verbatim. Paired with `ESCAPE '\'`.
 */
const escapeLike = (literal: string): string => literal.replace(/[\\%_]/g, (c) => `\\${c}`);

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
export function createPostgresStorage(options: PostgresStorageOptions): PostgresAuditStorage {
  const table = assertSafeIdentifier(options.table ?? "xtandard_audit");
  const names = eventTableNames(table);
  const { events: ev, targets: tg } = names;
  const connectionString = options.connectionString ?? options.url;
  const ownsClient = !options.client;

  let client: ClosableSqlClient | undefined = options.client;
  let connecting: Promise<ClosableSqlClient> | undefined;
  let ensured: Promise<void> | undefined;

  /** Resolve a client, creating a `pg` `Pool` on first use when needed. */
  async function getClient(): Promise<ClosableSqlClient> {
    if (client) return client;
    connecting ??= (async () => {
      let Pool: new (config: { connectionString?: string }) => ClosableSqlClient;
      try {
        ({ Pool } = (await import("pg")) as unknown as {
          Pool: new (config: { connectionString?: string }) => ClosableSqlClient;
        });
      } catch {
        requirePeer("pg", "storage/postgres");
      }
      client = new Pool({ connectionString });
      return client;
    })();
    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  }

  /** Create the backing tables once, before the first operation. */
  async function ensureTable(): Promise<ClosableSqlClient> {
    const c = await getClient();
    ensured ??= (async () => {
      await c.query(
        `CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, value jsonb NOT NULL)`,
      );
      for (const ddl of eventLogDdl("postgres", table)) await c.query(ddl);
    })();
    try {
      await ensured;
    } catch (err) {
      ensured = undefined; // let a later call retry the DDL
      throw err;
    }
    return c;
  }

  /**
   * Normalise a `jsonb` column value. Both `pg` and `pglite` typically return
   * it already parsed, but parse a string defensively so either driver works.
   */
  const parseValue = <T>(value: unknown): T => {
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    }
    return value as T;
  };

  const rows = async (text: string, params: unknown[]) =>
    (await (await ensureTable()).query(text, params)).rows;

  const one = async (text: string, params: unknown[]) => {
    const [row] = await rows(text, params);
    return row ? parseEvent(row.data) : null;
  };

  return {
    async getItem<T>(key: string): Promise<T | null> {
      const [row] = await rows(`SELECT value FROM ${table} WHERE key = $1`, [key]);
      if (row === undefined || row.value === null || row.value === undefined) return null;
      return parseValue<T>(row.value);
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      await rows(
        `INSERT INTO ${table} (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    },

    async removeItem(key: string): Promise<void> {
      await rows(`DELETE FROM ${table} WHERE key = $1`, [key]);
    },

    async getKeys(prefix: string): Promise<string[]> {
      const found = await rows(`SELECT key FROM ${table} WHERE key LIKE $1 ESCAPE '\\'`, [
        `${escapeLike(prefix)}%`,
      ]);
      // Exact prefix semantics whatever the column collation.
      return found.map((row) => String(row.key)).filter((key) => key.startsWith(prefix));
    },

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

    async close(): Promise<void> {
      if (ownsClient && client?.end) await client.end();
    },
  } satisfies PostgresAuditStorage;
}
