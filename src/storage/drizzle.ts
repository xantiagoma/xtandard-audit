/**
 * Drizzle storage adapter — an `AuditStorage` over **consumer-owned**
 * Drizzle tables and database. Unlike {@link ./postgres.createPostgresStorage}
 * it issues **no DDL** (the tables live in your Drizzle schema + migrations)
 * and **owns no connection** (it reuses the `db` you pass, and never closes it).
 *
 * Dialect-agnostic: works with Postgres, MySQL, and SQLite Drizzle databases.
 * Build the tables with the matching factory —
 * {@link ../drizzle/pg.pgAuditTables} / {@link ../drizzle/mysql.mysqlAuditTables} /
 * {@link ../drizzle/sqlite.sqliteAuditTables} (or the per-table factories).
 * Control data goes to the KV `table` through `@xtandard/kit/storage/drizzle`
 * (canonical JSON, `compareAndSwap` on every dialect, literal prefixes; on
 * MySQL, keys are matched byte-exactly and a write whose key differs from a
 * stored one only by trailing spaces throws `KeyCollisionError`); when you also pass `events` and
 * `eventTargets`, the adapter implements the **native event log** (ADR 0005):
 * indexed queries compiled with Drizzle's query builder, and appends in one
 * transaction that checks the tenant's head seq. Without them it is KV-only and
 * the core falls back to its generic KV event log.
 *
 * The dialect is read from `db` (or set with `dialect`), and `drizzle-orm` is
 * loaded on first use. Transactions use `db.transaction`: async callbacks on Postgres, MySQL and
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

import { importPeer } from "@xtandard/kit/storage";
import * as kit from "@xtandard/kit/storage/drizzle";
import { detectDrizzleDialect, type DrizzleDialect } from "@xtandard/kit/storage/drizzle/internals";
import type { SQL, Table } from "drizzle-orm";
import type { NormalizedQuery } from "../query.ts";
import { ChainConflictError, type EventLogStorage } from "./contract.ts";
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
import type { DrizzleEventTargetsTable, DrizzleEventsTable } from "../drizzle/table.ts";

export type {
  DrizzleAuditTables,
  DrizzleEventTargetsTable,
  DrizzleEventsTable,
  DrizzleKvTable,
} from "../drizzle/table.ts";
export { KeyCollisionError, type DrizzleDialect } from "@xtandard/kit/storage/drizzle";

const SUBPATH = "@xtandard/audit/storage/drizzle";

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
export interface DrizzleStorageOptions extends kit.DrizzleStorageOptions {
  /** The events table (`*AuditEventsTable`). Pass with `eventTargets` for the native event log. */
  events?: DrizzleEventsTable;
  /** The event-targets table (`*AuditEventTargetsTable`). */
  eventTargets?: DrizzleEventTargetsTable;
}

/**
 * A KV-only, compare-and-swap capable `AuditStorage` over a Drizzle table. For push
 * change-notifications, compose it with {@link ./watch.withWatch} + a change
 * source (e.g. {@link ./watch.pgListenNotify}) — `watch` is orthogonal to the
 * adapter.
 */
export type DrizzleAuditStorage = kit.DrizzleKvStorage;

/** A Drizzle storage with the native {@link EventLogStorage} capability (and `compareAndSwap`). */
export type DrizzleEventLogAuditStorage = EventLogStorage & kit.DrizzleKvStorage;

/** Rows per INSERT statement (keeps every dialect well under its bind-parameter limit). */
const INSERT_CHUNK = 500;

type DrizzleOrm = typeof import("drizzle-orm");
let orm: Promise<DrizzleOrm> | undefined;

/** `drizzle-orm`, imported once on first use (a failed import is retried). */
function drizzleOrm(): Promise<DrizzleOrm> {
  orm ??= importPeer("drizzle-orm", SUBPATH, () => import("drizzle-orm")).catch(
    (error: unknown) => {
      orm = undefined;
      throw error;
    },
  );
  return orm;
}

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += INSERT_CHUNK) out.push(list.slice(i, i + INSERT_CHUNK));
  return out;
}

/**
 * Create a Drizzle-backed storage. No DDL, no connection ownership. The
 * dialect is detected from `db` (or set with `dialect`). With `events` +
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
  if (!options.events !== !options.eventTargets) {
    throw new Error("createDrizzleStorage: pass both `events` and `eventTargets`, or neither");
  }
  const dialect = options.dialect ?? detectDrizzleDialect(options.db, SUBPATH);
  const kv = kit.createDrizzleStorage({ subpath: SUBPATH, ...options, dialect });
  if (!options.events || !options.eventTargets) return kv;
  return {
    ...kv,
    ...createDrizzleEventLog(
      options.db as DrizzleEventLogDatabase,
      dialect,
      options.events,
      options.eventTargets,
    ),
  } satisfies DrizzleEventLogAuditStorage;
}

/** The native event log over Drizzle's query builder. */
function createDrizzleEventLog(
  db: DrizzleEventLogDatabase,
  dialect: DrizzleDialect,
  ev: DrizzleEventsTable,
  tg: DrizzleEventTargetsTable,
): EventLogMethods {
  const sync = db.resultKind === "sync";
  // SQLite's LIKE folds ASCII case; GLOB is case-sensitive like the in-memory matcher.
  const actionPrefix = (d: DrizzleOrm, pre: string): SQL =>
    dialect === "sqlite"
      ? d.sql`${ev.action} glob ${`${escapeGlob(pre)}*`}`
      : d.sql`${ev.action} like ${`${escapeLike(pre)}%`} escape '!'`;

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

  /** The first row's event for `where`, in `order`. */
  const one = async (where: (d: DrizzleOrm) => SQL | undefined, order?: (d: DrizzleOrm) => SQL) => {
    const d = await drizzleOrm();
    let q = db.select({ data: ev.data }).from(ev).where(where(d));
    if (order) q = q.orderBy(order(d));
    const [row] = (await q.limit(1)) as Row[];
    return row ? parseEvent(row.data) : null;
  };

  function whereFor(d: DrizzleOrm, q: NormalizedQuery): SQL | undefined {
    const conds: (SQL | undefined)[] = [];
    if (q.tenant !== undefined) conds.push(d.eq(ev.tenant, q.tenant));
    if (q.actions.length > 0 || q.actionPrefixes.length > 0) {
      conds.push(
        d.or(
          q.actions.length > 0 ? d.inArray(ev.action, q.actions) : undefined,
          ...q.actionPrefixes.map((pre) => actionPrefix(d, pre)),
        ),
      );
    }
    if (q.excludeActions.length > 0) conds.push(d.notInArray(ev.action, q.excludeActions));
    for (const pre of q.excludeActionPrefixes) conds.push(d.not(actionPrefix(d, pre)));
    if (q.actorId !== undefined) conds.push(d.eq(ev.actorId, q.actorId));
    if (q.actorType !== undefined) conds.push(d.eq(ev.actorType, q.actorType));
    if (q.targetType !== undefined || q.targetId !== undefined) {
      conds.push(
        d.exists(
          db
            .select({ one: d.sql`1` })
            .from(tg)
            .where(
              d.and(
                d.eq(tg.tenant, ev.tenant),
                d.eq(tg.seq, ev.seq),
                q.targetType !== undefined ? d.eq(tg.type, q.targetType) : undefined,
                q.targetId !== undefined ? d.eq(tg.targetId, q.targetId) : undefined,
              ),
            ),
        ),
      );
    }
    if (q.outcome !== undefined) conds.push(d.eq(ev.outcome, q.outcome));
    if (q.from !== undefined) conds.push(d.gte(ev.occurredAt, q.from));
    if (q.to !== undefined) conds.push(d.lt(ev.occurredAt, q.to));
    if (q.search !== undefined) {
      conds.push(d.sql`${ev.search} like ${`%${escapeLike(q.search)}%`} escape '!'`);
    }
    if (q.after) {
      const cmp = q.order === "desc" ? d.lt : d.gt;
      conds.push(
        d.or(
          cmp(ev.occurredAt, q.after.occurredAt),
          d.and(d.eq(ev.occurredAt, q.after.occurredAt), cmp(ev.id, q.after.id)),
        ),
      );
    }
    return d.and(...conds);
  }

  return {
    async appendEvents(tenant, events, { expectedSeq }) {
      if (events.length === 0) return;
      assertContiguous(tenant, events, expectedSeq);
      const d = await drizzleOrm();
      const eventRows = events.map((e) => ({ ...eventColumns(e), data: e }));
      const targetRows = events.flatMap((e) =>
        eventTargets(e).map((t) => ({ tenant, seq: e.seq, type: t.type, targetId: t.targetId })),
      );
      try {
        await atomic(
          (tx) =>
            tx
              .select({ m: d.max(ev.seq) })
              .from(ev)
              .where(d.eq(ev.tenant, tenant)),
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

    getEvent: (tenant, id) => one((d) => d.and(d.eq(ev.tenant, tenant), d.eq(ev.id, id))),

    lastEvent: (tenant) =>
      one(
        (d) => d.eq(ev.tenant, tenant),
        (d) => d.desc(ev.seq),
      ),

    async eventsBySeq(tenant, { afterSeq, limit }) {
      const d = await drizzleOrm();
      const rows = (await db
        .select({ data: ev.data })
        .from(ev)
        .where(d.and(d.eq(ev.tenant, tenant), d.gt(ev.seq, afterSeq)))
        .orderBy(d.asc(ev.seq))
        .limit(limit)) as Row[];
      return rows.map((r) => parseEvent(r.data));
    },

    async queryEvents(q) {
      const d = await drizzleOrm();
      const dir = q.order === "desc" ? d.desc : d.asc;
      const rows = (await db
        .select({ data: ev.data })
        .from(ev)
        .where(whereFor(d, q))
        .orderBy(dir(ev.occurredAt), dir(ev.id))
        .limit(q.limit + 1)) as Row[];
      return toQueryResult(rows, q.limit);
    },

    async replaceEvent(event) {
      const d = await drizzleOrm();
      const c = eventColumns(event);
      const key = d.and(d.eq(ev.tenant, c.tenant), d.eq(ev.seq, c.seq), d.eq(ev.id, c.id));
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
                tx.delete(tg).where(d.and(d.eq(tg.tenant, c.tenant), d.eq(tg.seq, c.seq))),
                ...(targets.length > 0 ? [tx.insert(tg).values(targets)] : []),
              ],
      );
    },

    async deleteEventsThrough(tenant, throughSeq) {
      const d = await drizzleOrm();
      const [row] = await atomic(
        (tx) =>
          tx
            .select({ n: d.count() })
            .from(ev)
            .where(d.and(d.eq(ev.tenant, tenant), d.lte(ev.seq, throughSeq))),
        (tx) => [
          tx.delete(tg).where(d.and(d.eq(tg.tenant, tenant), d.lte(tg.seq, throughSeq))),
          tx.delete(ev).where(d.and(d.eq(ev.tenant, tenant), d.lte(ev.seq, throughSeq))),
        ],
      );
      return Number(row?.n ?? 0);
    },

    async countEvents(tenant) {
      const d = await drizzleOrm();
      let q = db.select({ n: d.count() }).from(ev);
      if (tenant !== undefined) q = q.where(d.eq(ev.tenant, tenant));
      const [row] = (await q) as Row[];
      return Number(row?.n ?? 0);
    },

    async listEventTenants() {
      const d = await drizzleOrm();
      const rows = (await db
        .selectDistinct({ tenant: ev.tenant })
        .from(ev)
        .orderBy(d.asc(ev.tenant))) as Row[];
      return rows.map((r) => String(r.tenant));
    },
  };
}
