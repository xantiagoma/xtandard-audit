/**
 * Drizzle storage adapter — a {@link AuditStorage} over **consumer-owned**
 * Drizzle tables and database. Unlike {@link ./postgres.createPostgresStorage}
 * it issues **no DDL** (the tables live in your Drizzle schema + migrations)
 * and **owns no connection** (it reuses the `db` you pass, and never closes it).
 *
 * Dialect-agnostic: works with Postgres, MySQL, and SQLite Drizzle databases.
 * Build the tables with the matching factory —
 * {@link ../drizzle/pg.pgAuditTables} / {@link ../drizzle/mysql.mysqlAuditTables} /
 * {@link ../drizzle/sqlite.sqliteAuditTables} (or the per-table factories).
 * Control data goes to the KV `table`; when you also pass `events` and
 * `eventTargets`, the adapter implements the **native event log** (ADR 0005):
 * indexed queries compiled with Drizzle's query builder, and appends in one
 * transaction that checks the tenant's head seq. Without them it is KV-only and
 * the core falls back to its generic KV event log.
 *
 * Transactions use `db.transaction`: async callbacks on Postgres, MySQL and
 * async SQLite drivers (libSQL), a synchronous `immediate` transaction on sync
 * SQLite drivers (`bun:sqlite`, `better-sqlite3`). Drivers without
 * transactions (e.g. `neon-http`) cannot use the native event log.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { createDrizzleStorage } from "@xtandard/audit/storage/drizzle";
 * import { pgAuditTables } from "@xtandard/audit/drizzle/pg";
 *
 * // schema.ts: export each table so drizzle-kit migrates it
 * export const {
 *   table: auditKv,
 *   events: auditEvents,
 *   eventTargets: auditEventTargets,
 * } = pgAuditTables();
 *
 * const db = drizzle(pool); // your existing pool
 * const storage = createDrizzleStorage({
 *   db,
 *   table: auditKv,
 *   events: auditEvents,
 *   eventTargets: auditEventTargets,
 * });
 * ```
 *
 * @module
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  is,
  lt,
  lte,
  max,
  not,
  notInArray,
  or,
  sql,
  type Column,
  type SQL,
  type Table,
} from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { NormalizedQuery } from "../query.ts";
import { ChainConflictError, type AuditStorage, type EventLogStorage } from "./contract.ts";
import {
  assertContiguous,
  escapeGlob,
  escapeLike,
  eventColumns,
  eventTargets,
  isWriteConflict,
  parseEvent,
  toQueryResult,
  type EventLogMethods,
} from "./sql.ts";
import type {
  DrizzleEventTargetsTable,
  DrizzleEventsTable,
  DrizzleKvTable,
} from "../drizzle/table.ts";

export type {
  DrizzleAuditTables,
  DrizzleEventTargetsTable,
  DrizzleEventsTable,
  DrizzleKvTable,
} from "../drizzle/table.ts";

/**
 * Minimal structural view of a Drizzle database — the query-builder entry points
 * the KV adapter uses. This is the internal contract the adapter casts `db` to;
 * the public option is typed `unknown` because a dialect-agnostic structural type
 * cannot match dialect-specific dbs (their `.from`/`.insert` want `PgTable` etc.,
 * not the base `Table`). The upsert method differs by dialect and is
 * feature-detected at runtime.
 */
interface DrizzleLikeDatabase {
  select(fields: Record<string, Column>): {
    from(table: Table): { where(where: SQL): PromiseLike<unknown[]> };
  };
  insert(table: Table): {
    values(row: { key: string; value: unknown }): {
      /** Postgres + SQLite upsert. */
      onConflictDoUpdate?(config: {
        target: Column;
        set: { value: unknown };
      }): PromiseLike<unknown>;
      /** MySQL upsert. */
      onDuplicateKeyUpdate?(config: { set: { value: unknown } }): PromiseLike<unknown>;
    };
  };
  delete(table: Table): { where(where: SQL): PromiseLike<unknown> };
}

/**
 * A Drizzle query builder as the event log uses it: chainable, awaitable, and
 * (on sync SQLite drivers) executable with `all()` / `run()`. Loosely typed on
 * purpose — the dialect-specific builder types do not unify.
 */
interface Builder extends PromiseLike<unknown> {
  [method: string]: any;
}

/** The Drizzle database surface the event log uses (any dialect). */
interface DrizzleEventLogDatabase {
  select(fields?: Record<string, unknown>): Builder;
  selectDistinct(fields: Record<string, unknown>): Builder;
  insert(table: Table): Builder;
  update(table: Table): Builder;
  delete(table: Table): Builder;
  transaction(fn: (tx: DrizzleEventLogDatabase) => unknown, config?: unknown): Promise<unknown>;
  /** `"sync"` on `bun:sqlite` / `better-sqlite3` Drizzle databases. */
  resultKind?: string;
}

/** Options for {@link createDrizzleStorage}. */
export interface DrizzleStorageOptions {
  /**
   * Your Drizzle database (node-postgres / mysql2 / better-sqlite3 / pglite / …).
   * Typed `unknown` intentionally — a single dialect-agnostic type can't match
   * every dialect's db; the adapter only calls the query builder and
   * `transaction`.
   */
  db: unknown;
  /** The KV table built with a `*AuditTable` factory (or matching that shape). */
  table: DrizzleKvTable;
  /** The events table (`*AuditEventsTable`). Pass with `eventTargets` for the native event log. */
  events?: DrizzleEventsTable;
  /** The event-targets table (`*AuditEventTargetsTable`). */
  eventTargets?: DrizzleEventTargetsTable;
}

/**
 * A KV-only {@link AuditStorage} over a Drizzle table. For push
 * change-notifications, compose it with {@link ./watch.withWatch} + a change
 * source (e.g. {@link ./watch.pgListenNotify}) — `watch` is orthogonal to the
 * adapter.
 */
export type DrizzleAuditStorage = AuditStorage;

/** A Drizzle storage with the native {@link EventLogStorage} capability. */
export type DrizzleEventLogAuditStorage = EventLogStorage;

/** Rows per INSERT statement (keeps every dialect well under its bind-parameter limit). */
const INSERT_CHUNK = 500;

/** Parse a value defensively — Drizzle returns json parsed, but a string is parsed too. */
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

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += INSERT_CHUNK) out.push(list.slice(i, i + INSERT_CHUNK));
  return out;
}

/**
 * Create a Drizzle-backed storage. No DDL, no connection ownership. The upsert
 * dialect (Postgres/SQLite `onConflictDoUpdate` vs MySQL `onDuplicateKeyUpdate`)
 * is detected at runtime from the insert builder. With `events` +
 * `eventTargets` the result implements the native event log.
 */
export function createDrizzleStorage(
  options: DrizzleStorageOptions & {
    events: DrizzleEventsTable;
    eventTargets: DrizzleEventTargetsTable;
  },
): DrizzleEventLogAuditStorage;
export function createDrizzleStorage(options: DrizzleStorageOptions): DrizzleAuditStorage;
export function createDrizzleStorage(
  options: DrizzleStorageOptions,
): DrizzleAuditStorage | DrizzleEventLogAuditStorage {
  const db = options.db as DrizzleLikeDatabase;
  const { table } = options;
  if (!options.events !== !options.eventTargets) {
    throw new Error("createDrizzleStorage: pass both `events` and `eventTargets`, or neither");
  }

  const kv: AuditStorage = {
    async getItem<T>(key: string): Promise<T | null> {
      const rows = (await db
        .select({ value: table.value })
        .from(table)
        .where(eq(table.key, key))) as Array<{ value: unknown }>;
      const row = rows[0];
      if (row === undefined || row.value === null || row.value === undefined) return null;
      return parseValue<T>(row.value);
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      const insert = db.insert(table).values({ key, value });
      if (typeof insert.onConflictDoUpdate === "function") {
        await insert.onConflictDoUpdate({ target: table.key, set: { value } });
      } else if (typeof insert.onDuplicateKeyUpdate === "function") {
        await insert.onDuplicateKeyUpdate({ set: { value } });
      } else {
        throw new Error(
          "createDrizzleStorage: the Drizzle database exposes no known upsert method " +
            "(onConflictDoUpdate / onDuplicateKeyUpdate).",
        );
      }
    },

    async removeItem(key: string): Promise<void> {
      await db.delete(table).where(eq(table.key, key));
    },

    async getKeys(prefix: string): Promise<string[]> {
      // `!` as the LIKE escape: a backslash literal is not portable (MySQL eats it).
      const pattern = `${escapeLike(prefix)}%`;
      const rows = (await db
        .select({ key: table.key })
        .from(table)
        .where(sql`${table.key} like ${pattern} escape '!'`)) as Array<{ key: unknown }>;
      return rows.map((row) => String(row.key));
    },
  };

  if (!options.events || !options.eventTargets) return kv;
  return {
    ...kv,
    ...createDrizzleEventLog(
      options.db as DrizzleEventLogDatabase,
      options.events,
      options.eventTargets,
    ),
  } satisfies DrizzleEventLogAuditStorage;
}

/** The native event log over Drizzle's query builder. */
function createDrizzleEventLog(
  db: DrizzleEventLogDatabase,
  ev: DrizzleEventsTable,
  tg: DrizzleEventTargetsTable,
): EventLogMethods {
  const sync = db.resultKind === "sync";
  // SQLite's LIKE folds ASCII case; GLOB is case-sensitive like the in-memory matcher.
  const sqlite = is(ev as object, SQLiteTable); // (not `is(ev, …)`: that would narrow `ev`)
  const actionPrefix = (pre: string): SQL =>
    sqlite
      ? sql`${ev.action} glob ${`${escapeGlob(pre)}*`}`
      : sql`${ev.action} like ${`${escapeLike(pre)}%`} escape '!'`;

  type Row = Record<string, unknown>;

  /**
   * Run `read`, then the writes `write` derives from its rows, in one
   * transaction; resolves to the rows read. Sync SQLite drivers need a
   * synchronous callback (`all()`/`run()`), everything else awaits builders.
   */
  async function atomic(
    read: (tx: DrizzleEventLogDatabase) => Builder,
    write: (tx: DrizzleEventLogDatabase, rows: Row[]) => Builder[],
  ): Promise<Row[]> {
    if (sync) {
      return (await db.transaction(
        (tx) => {
          const rows = read(tx).all() as Row[];
          for (const w of write(tx, rows)) w.run();
          return rows;
        },
        { behavior: "immediate" },
      )) as Row[];
    }
    return (await db.transaction(async (tx) => {
      const rows = (await read(tx)) as Row[];
      for (const w of write(tx, rows)) await w;
      return rows;
    })) as Row[];
  }

  const one = async (where: SQL, order?: SQL) => {
    let q = db.select({ data: ev.data }).from(ev).where(where);
    if (order) q = q.orderBy(order);
    const [row] = (await q.limit(1)) as Row[];
    return row ? parseEvent(row.data) : null;
  };

  function whereFor(q: NormalizedQuery): SQL | undefined {
    const conds: (SQL | undefined)[] = [];
    if (q.tenant !== undefined) conds.push(eq(ev.tenant, q.tenant));
    if (q.actions.length > 0 || q.actionPrefixes.length > 0) {
      conds.push(
        or(
          q.actions.length > 0 ? inArray(ev.action, q.actions) : undefined,
          ...q.actionPrefixes.map(actionPrefix),
        ),
      );
    }
    if (q.excludeActions.length > 0) conds.push(notInArray(ev.action, q.excludeActions));
    for (const pre of q.excludeActionPrefixes) conds.push(not(actionPrefix(pre)));
    if (q.actorId !== undefined) conds.push(eq(ev.actorId, q.actorId));
    if (q.actorType !== undefined) conds.push(eq(ev.actorType, q.actorType));
    if (q.targetType !== undefined || q.targetId !== undefined) {
      conds.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(tg)
            .where(
              and(
                eq(tg.tenant, ev.tenant),
                eq(tg.seq, ev.seq),
                q.targetType !== undefined ? eq(tg.type, q.targetType) : undefined,
                q.targetId !== undefined ? eq(tg.targetId, q.targetId) : undefined,
              ),
            ),
        ),
      );
    }
    if (q.outcome !== undefined) conds.push(eq(ev.outcome, q.outcome));
    if (q.from !== undefined) conds.push(gte(ev.occurredAt, q.from));
    if (q.to !== undefined) conds.push(lt(ev.occurredAt, q.to));
    if (q.search !== undefined) {
      conds.push(sql`${ev.search} like ${`%${escapeLike(q.search)}%`} escape '!'`);
    }
    if (q.after) {
      const cmp = q.order === "desc" ? lt : gt;
      conds.push(
        or(
          cmp(ev.occurredAt, q.after.occurredAt),
          and(eq(ev.occurredAt, q.after.occurredAt), cmp(ev.id, q.after.id)),
        ),
      );
    }
    return and(...conds);
  }

  return {
    async appendEvents(tenant, events, { expectedSeq }) {
      if (events.length === 0) return;
      assertContiguous(tenant, events, expectedSeq);
      const eventRows = events.map((e) => ({ ...eventColumns(e), data: e }));
      const targetRows = events.flatMap((e) =>
        eventTargets(e).map((t) => ({ tenant, seq: e.seq, type: t.type, targetId: t.targetId })),
      );
      try {
        await atomic(
          (tx) =>
            tx
              .select({ m: max(ev.seq) })
              .from(ev)
              .where(eq(ev.tenant, tenant)),
          (tx, rows) => {
            // The tenant's head must be the expected one (or empty, e.g. after a full prune).
            const head = Number(rows[0]?.m ?? 0);
            if (head !== expectedSeq && head !== 0) {
              throw new ChainConflictError(tenant, expectedSeq);
            }
            return [
              ...chunks(eventRows).map((c) => tx.insert(ev).values(c)),
              ...chunks(targetRows).map((c) => tx.insert(tg).values(c)),
            ];
          },
        );
      } catch (err) {
        if (err instanceof ChainConflictError) throw err;
        if (isWriteConflict(err)) throw new ChainConflictError(tenant, expectedSeq);
        throw err;
      }
    },

    getEvent: (tenant, id) => one(and(eq(ev.tenant, tenant), eq(ev.id, id))!),

    lastEvent: (tenant) => one(eq(ev.tenant, tenant), desc(ev.seq)),

    async eventsBySeq(tenant, { afterSeq, limit }) {
      const rows = (await db
        .select({ data: ev.data })
        .from(ev)
        .where(and(eq(ev.tenant, tenant), gt(ev.seq, afterSeq)))
        .orderBy(asc(ev.seq))
        .limit(limit)) as Row[];
      return rows.map((r) => parseEvent(r.data));
    },

    async queryEvents(q) {
      const dir = q.order === "desc" ? desc : asc;
      const rows = (await db
        .select({ data: ev.data })
        .from(ev)
        .where(whereFor(q))
        .orderBy(dir(ev.occurredAt), dir(ev.id))
        .limit(q.limit + 1)) as Row[];
      return toQueryResult(rows, q.limit);
    },

    async replaceEvent(event) {
      const c = eventColumns(event);
      const key = and(eq(ev.tenant, c.tenant), eq(ev.seq, c.seq), eq(ev.id, c.id));
      const targets = eventTargets(event).map((t) => ({
        tenant: c.tenant,
        seq: c.seq,
        type: t.type,
        targetId: t.targetId,
      }));
      await atomic(
        (tx) => tx.select({ seq: ev.seq }).from(ev).where(key),
        (tx, rows) =>
          rows.length === 0
            ? []
            : [
                tx
                  .update(ev)
                  .set({
                    action: c.action,
                    occurredAt: c.occurredAt,
                    recordedAt: c.recordedAt,
                    actorId: c.actorId,
                    actorType: c.actorType,
                    outcome: c.outcome,
                    search: c.search,
                    data: event,
                  })
                  .where(key),
                tx.delete(tg).where(and(eq(tg.tenant, c.tenant), eq(tg.seq, c.seq))),
                ...(targets.length > 0 ? [tx.insert(tg).values(targets)] : []),
              ],
      );
    },

    async deleteEventsThrough(tenant, throughSeq) {
      const [row] = await atomic(
        (tx) =>
          tx
            .select({ n: count() })
            .from(ev)
            .where(and(eq(ev.tenant, tenant), lte(ev.seq, throughSeq))),
        (tx) => [
          tx.delete(tg).where(and(eq(tg.tenant, tenant), lte(tg.seq, throughSeq))),
          tx.delete(ev).where(and(eq(ev.tenant, tenant), lte(ev.seq, throughSeq))),
        ],
      );
      return Number(row?.n ?? 0);
    },

    async countEvents(tenant) {
      let q = db.select({ n: count() }).from(ev);
      if (tenant !== undefined) q = q.where(eq(ev.tenant, tenant));
      const [row] = (await q) as Row[];
      return Number(row?.n ?? 0);
    },

    async listEventTenants() {
      const rows = (await db
        .selectDistinct({ tenant: ev.tenant })
        .from(ev)
        .orderBy(asc(ev.tenant))) as Row[];
      return rows.map((r) => String(r.tenant));
    },
  };
}
