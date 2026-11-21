/**
 * The native event log for SQLite-dialect drivers — shared by `storage/sqlite`
 * (`bun:sqlite`) and `storage/libsql`, which differ only in how they execute
 * statements (see {@link SqliteExecutor}). Internal — not a public subpath.
 * Tested under `bun test` (it needs a real SQLite engine), so it is excluded
 * from vitest coverage like the two drivers.
 *
 * @module
 */

import { ChainConflictError } from "./contract.ts";
import {
  assertContiguous,
  compileEventQuery,
  eventColumns,
  eventTableNames,
  eventTargets,
  isWriteConflict,
  parseEvent,
  toQueryResult,
  type EventLogMethods,
  type SqlStatement,
} from "./sql.ts";

/**
 * The minimal executor a SQLite-dialect driver provides: `all` for reads, and
 * `atomic` running statements in one write transaction (all or nothing),
 * resolving to each statement's affected-row count.
 */
export interface SqliteExecutor {
  all(sql: string, args: unknown[]): Promise<Array<Record<string, unknown>>>;
  atomic(statements: SqlStatement[]): Promise<number[]>;
}

/**
 * The native event log over a SQLite-dialect {@link SqliteExecutor}.
 *
 * Appends are two guarded `INSERT … SELECT … FROM json_each(?)` statements in
 * one write transaction: both only insert when the tenant's current max seq is
 * `expectedSeq` (or the tenant has no rows, e.g. after a full prune), and both
 * guards read the same pre-append state (targets are inserted first). A guard
 * miss inserts nothing and becomes a {@link ChainConflictError}, as does a
 * `(tenant, seq)` / `(tenant, id)` unique violation from a concurrent writer.
 */
export function createSqliteEventLog(
  exec: () => Promise<SqliteExecutor>,
  table: string,
): EventLogMethods {
  const names = eventTableNames(table);
  const { events: ev, targets: tg } = names;
  const guard = `(SELECT COALESCE(MAX(seq), 0) FROM ${ev} WHERE tenant = ?) IN (?, 0)`;

  const one = async (sql: string, args: unknown[]) => {
    const rows = await (await exec()).all(sql, args);
    return rows[0] ? parseEvent(rows[0].data) : null;
  };

  return {
    async appendEvents(tenant, events, { expectedSeq }) {
      if (events.length === 0) return;
      assertContiguous(tenant, events, expectedSeq);
      const rows = events.map((e) => {
        const c = eventColumns(e);
        return [
          c.seq,
          c.id,
          c.action,
          c.occurredAt,
          c.recordedAt,
          c.actorId,
          c.actorType,
          c.outcome,
          c.search,
          JSON.stringify(e),
        ];
      });
      const targets = events.flatMap((e) =>
        eventTargets(e).map((t) => [e.seq, t.type, t.targetId]),
      );
      const col = (i: number) => `json_extract(r.value, '$[${i}]')`;
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO ${tg} (tenant, seq, type, target_id)
            SELECT ?, ${col(0)}, ${col(1)}, ${col(2)} FROM json_each(?) r WHERE ${guard}`,
          args: [tenant, JSON.stringify(targets), tenant, expectedSeq],
        },
        {
          sql: `INSERT INTO ${ev} (tenant, seq, id, action, occurred_at, recorded_at, actor_id,
              actor_type, outcome, search, data)
            SELECT ?, ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(col).join(", ")}
            FROM json_each(?) r WHERE ${guard}`,
          args: [tenant, JSON.stringify(rows), tenant, expectedSeq],
        },
      ];
      let inserted: number;
      try {
        [, inserted = 0] = await (await exec()).atomic(statements);
      } catch (err) {
        if (isWriteConflict(err)) throw new ChainConflictError(tenant, expectedSeq);
        throw err;
      }
      if (inserted !== events.length) throw new ChainConflictError(tenant, expectedSeq);
    },

    getEvent: (tenant, id) =>
      one(`SELECT data FROM ${ev} WHERE tenant = ? AND id = ?`, [tenant, id]),

    lastEvent: (tenant) =>
      one(`SELECT data FROM ${ev} WHERE tenant = ? ORDER BY seq DESC LIMIT 1`, [tenant]),

    async eventsBySeq(tenant, { afterSeq, limit }) {
      const rows = await (
        await exec()
      ).all(`SELECT data FROM ${ev} WHERE tenant = ? AND seq > ? ORDER BY seq ASC LIMIT ?`, [
        tenant,
        afterSeq,
        limit,
      ]);
      return rows.map((r) => parseEvent(r.data));
    },

    async queryEvents(q) {
      const { sql, args } = compileEventQuery("sqlite", names, q);
      return toQueryResult(await (await exec()).all(sql, args), q.limit);
    },

    async replaceEvent(event) {
      const c = eventColumns(event);
      const own = `EXISTS (SELECT 1 FROM ${ev} WHERE tenant = ? AND seq = ? AND id = ?)`;
      const key = [c.tenant, c.seq, c.id];
      const targets = eventTargets(event).map((t) => [t.type, t.targetId]);
      await (
        await exec()
      ).atomic([
        {
          sql: `DELETE FROM ${tg} WHERE tenant = ? AND seq = ? AND ${own}`,
          args: [c.tenant, c.seq, ...key],
        },
        {
          sql: `INSERT INTO ${tg} (tenant, seq, type, target_id)
            SELECT ?, ?, json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]')
            FROM json_each(?) r WHERE ${own}`,
          args: [c.tenant, c.seq, JSON.stringify(targets), ...key],
        },
        {
          sql: `UPDATE ${ev} SET action = ?, occurred_at = ?, recorded_at = ?, actor_id = ?,
              actor_type = ?, outcome = ?, search = ?, data = ?
            WHERE tenant = ? AND seq = ? AND id = ?`,
          args: [
            c.action,
            c.occurredAt,
            c.recordedAt,
            c.actorId,
            c.actorType,
            c.outcome,
            c.search,
            JSON.stringify(event),
            ...key,
          ],
        },
      ]);
    },

    async deleteEventsThrough(tenant, throughSeq) {
      const [, removed = 0] = await (
        await exec()
      ).atomic([
        { sql: `DELETE FROM ${tg} WHERE tenant = ? AND seq <= ?`, args: [tenant, throughSeq] },
        { sql: `DELETE FROM ${ev} WHERE tenant = ? AND seq <= ?`, args: [tenant, throughSeq] },
      ]);
      return removed;
    },

    async countEvents(tenant) {
      const rows = await (
        await exec()
      ).all(
        `SELECT COUNT(*) AS n FROM ${ev}${tenant !== undefined ? " WHERE tenant = ?" : ""}`,
        tenant !== undefined ? [tenant] : [],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async listEventTenants() {
      const rows = await (
        await exec()
      ).all(`SELECT DISTINCT tenant FROM ${ev} ORDER BY tenant`, []);
      return rows.map((r) => String(r.tenant));
    },
  };
}
