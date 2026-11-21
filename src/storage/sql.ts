/**
 * Shared plumbing for the SQL storage drivers (`postgres`, `sqlite`, `libsql`;
 * `drizzle` reuses the row mapping and error detection). Internal — not a
 * public subpath.
 *
 * The native event log (ADR 0005) lives in two tables next to the KV table:
 *
 * ```txt
 * {table}_events         (tenant, seq, id, action, occurred_at, recorded_at, actor_id,
 *                         actor_type, outcome, search, data)
 *                        PRIMARY KEY (tenant, seq), UNIQUE (tenant, id),
 *                        INDEX (tenant, occurred_at, id), (tenant, actor_id, …), (tenant, action, …)
 * {table}_event_targets  (tenant, seq, type, target_id)
 *                        INDEX (tenant, type, target_id, seq), (tenant, seq)
 * ```
 *
 * `data` is the full event (JSON) and is what reads return; the other columns
 * are denormalized for filtering and ordering. `occurred_at` is the event's
 * ISO-8601 UTC string (millisecond precision, `Z`), so it sorts
 * lexicographically; `actor_type` stores the effective type (`"user"` when the
 * event has none); `search` is {@link searchText}. Every query compiled here
 * agrees with the in-memory {@link matchesQuery} (the conformance suite checks it).
 *
 * @module
 */

import { searchText, type NormalizedQuery } from "../query.ts";
import type { AuditEvent } from "../schema.ts";
import { ChainConflictError, type EventLogStorage } from "./contract.ts";

/** Identifiers we are willing to interpolate into DDL/queries unquoted. */
export const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Throw unless `name` is a safe SQL identifier; returns it. */
export function assertSafeIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid table name ${JSON.stringify(name)}: must match ${SAFE_IDENTIFIER.source}`,
    );
  }
  return name;
}

/** The two event-log tables derived from a driver's base table name. */
export interface EventTableNames {
  events: string;
  targets: string;
}

/** `{table}_events` / `{table}_event_targets`. */
export const eventTableNames = (table: string): EventTableNames => ({
  events: `${table}_events`,
  targets: `${table}_event_targets`,
});

/**
 * Escape LIKE wildcards with `!` (portable across Postgres, MySQL and SQLite,
 * unlike a backslash, which MySQL string literals eat). Pair with `ESCAPE '!'`.
 */
export const escapeLike = (literal: string): string => literal.replace(/[!%_]/g, (c) => `!${c}`);

/** Escape GLOB metacharacters (SQLite's case-sensitive pattern match). */
export const escapeGlob = (literal: string): string => literal.replace(/[*?[]/g, (c) => `[${c}]`);

/** The scalar columns of one `{table}_events` row (without `data`). */
export interface EventColumns {
  tenant: string;
  seq: number;
  id: string;
  action: string;
  occurredAt: string;
  recordedAt: string;
  actorId: string;
  actorType: string;
  outcome: string | null;
  search: string;
}

/** Derive the denormalized columns of an event. */
export function eventColumns(event: AuditEvent): EventColumns {
  return {
    tenant: event.tenant,
    seq: event.seq,
    id: event.id,
    action: event.action,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    actorId: event.actor.id,
    actorType: event.actor.type ?? "user",
    outcome: event.outcome ?? null,
    search: searchText(event),
  };
}

/** The distinct `(type, id)` pairs of an event's targets. */
export function eventTargets(event: AuditEvent): { type: string; targetId: string }[] {
  const seen = new Set<string>();
  const out: { type: string; targetId: string }[] = [];
  for (const t of event.targets) {
    const k = `${t.type}\u0000${t.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ type: t.type, targetId: t.id });
  }
  return out;
}

/** Parse a stored `data` value (JSON text, or already parsed by the driver). */
export function parseEvent(value: unknown): AuditEvent {
  return (typeof value === "string" ? JSON.parse(value) : value) as AuditEvent;
}

/**
 * Is `err` (or one of its `cause`s — Drizzle wraps driver errors) a write
 * conflict another writer caused? Unique / primary-key violations (Postgres
 * `23505`, MySQL `ER_DUP_ENTRY` 1062, SQLite/libSQL `SQLITE_CONSTRAINT_*`) and
 * lock conflicts (Postgres `40001`/`40P01`, MySQL `ER_LOCK_DEADLOCK` 1213,
 * SQLite `SQLITE_BUSY`). Appends map these to {@link ChainConflictError} so the
 * core re-chains and retries.
 */
export function isWriteConflict(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === "object"; depth++) {
    const { code, errno, message } = e as { code?: unknown; errno?: unknown; message?: unknown };
    if (code === "23505" || code === "40001" || code === "40P01") return true;
    if (code === "ER_DUP_ENTRY" || code === "ER_LOCK_DEADLOCK") return true;
    if (errno === 1062 || errno === 1213) return true;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
    if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
      if (/UNIQUE|PRIMARY/i.test(`${code} ${String(message)}`)) return true;
    }
    if (
      typeof message === "string" &&
      /UNIQUE constraint failed|duplicate key value|Duplicate entry/.test(message)
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Validate that a batch continues the chain at `expectedSeq` with contiguous seqs. */
export function assertContiguous(tenant: string, events: AuditEvent[], expectedSeq: number): void {
  events.forEach((e, i) => {
    if (e.tenant !== tenant || e.seq !== expectedSeq + i + 1) {
      throw new ChainConflictError(tenant, expectedSeq);
    }
  });
}

/** SQL dialects the raw drivers compile to. */
export type SqlDialect = "postgres" | "sqlite";

/** A compiled statement. */
export interface SqlStatement {
  sql: string;
  args: unknown[];
}

/**
 * `CREATE TABLE/INDEX IF NOT EXISTS` statements for the event-log tables.
 * Postgres orders `occurred_at`, `id` and `action` with the `"C"` collation so
 * ordering and `LIKE` prefixes are bytewise (= the in-memory matcher) and
 * index-friendly whatever the database's default collation.
 */
export function eventLogDdl(dialect: SqlDialect, table: string): string[] {
  const { events, targets } = eventTableNames(assertSafeIdentifier(table));
  const pg = dialect === "postgres";
  const c = pg ? ` COLLATE "C"` : "";
  const int = pg ? "bigint" : "INTEGER";
  const json = pg ? "jsonb" : "TEXT";
  return [
    `CREATE TABLE IF NOT EXISTS ${events} (
      tenant text NOT NULL,
      seq ${int} NOT NULL,
      id text${c} NOT NULL,
      action text${c} NOT NULL,
      occurred_at text${c} NOT NULL,
      recorded_at text NOT NULL,
      actor_id text NOT NULL,
      actor_type text NOT NULL,
      outcome text,
      search text NOT NULL,
      data ${json} NOT NULL,
      PRIMARY KEY (tenant, seq),
      UNIQUE (tenant, id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${events}_time_idx ON ${events} (tenant, occurred_at, id)`,
    `CREATE INDEX IF NOT EXISTS ${events}_actor_idx ON ${events} (tenant, actor_id, occurred_at, id)`,
    `CREATE INDEX IF NOT EXISTS ${events}_action_idx ON ${events} (tenant, action, occurred_at, id)`,
    `CREATE TABLE IF NOT EXISTS ${targets} (
      tenant text NOT NULL,
      seq ${int} NOT NULL,
      type text NOT NULL,
      target_id text NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${targets}_target_idx ON ${targets} (tenant, type, target_id, seq)`,
    `CREATE INDEX IF NOT EXISTS ${targets}_seq_idx ON ${targets} (tenant, seq)`,
  ];
}

/**
 * Compile a {@link NormalizedQuery} to `SELECT data …` over the events table
 * aliased `e`: every filter, `(occurred_at, id)` keyset, order, `LIMIT limit+1`
 * (the extra row tells the caller whether more exist).
 */
export function compileEventQuery(
  dialect: SqlDialect,
  names: EventTableNames,
  q: NormalizedQuery,
): SqlStatement {
  const args: unknown[] = [];
  const p = (value: unknown) => {
    args.push(value);
    return dialect === "postgres" ? `$${args.length}` : "?";
  };
  // Action families: LIKE is case-sensitive in Postgres; SQLite's LIKE is not
  // (for ASCII), so it uses GLOB there.
  const prefix = (pre: string) =>
    dialect === "postgres"
      ? `e.action LIKE ${p(`${escapeLike(pre)}%`)} ESCAPE '!'`
      : `e.action GLOB ${p(`${escapeGlob(pre)}*`)}`;

  const where: string[] = [];
  if (q.tenant !== undefined) where.push(`e.tenant = ${p(q.tenant)}`);
  if (q.actions.length > 0 || q.actionPrefixes.length > 0) {
    const any: string[] = [];
    if (q.actions.length > 0) any.push(`e.action IN (${q.actions.map(p).join(", ")})`);
    for (const pre of q.actionPrefixes) any.push(prefix(pre));
    where.push(`(${any.join(" OR ")})`);
  }
  if (q.excludeActions.length > 0) {
    where.push(`e.action NOT IN (${q.excludeActions.map(p).join(", ")})`);
  }
  for (const pre of q.excludeActionPrefixes) where.push(`NOT (${prefix(pre)})`);
  if (q.actorId !== undefined) where.push(`e.actor_id = ${p(q.actorId)}`);
  if (q.actorType !== undefined) where.push(`e.actor_type = ${p(q.actorType)}`);
  if (q.targetType !== undefined || q.targetId !== undefined) {
    const t = [`t.tenant = e.tenant`, `t.seq = e.seq`];
    if (q.targetType !== undefined) t.push(`t.type = ${p(q.targetType)}`);
    if (q.targetId !== undefined) t.push(`t.target_id = ${p(q.targetId)}`);
    where.push(`EXISTS (SELECT 1 FROM ${names.targets} t WHERE ${t.join(" AND ")})`);
  }
  if (q.outcome !== undefined) where.push(`e.outcome = ${p(q.outcome)}`);
  if (q.from !== undefined) where.push(`e.occurred_at >= ${p(q.from)}`);
  if (q.to !== undefined) where.push(`e.occurred_at < ${p(q.to)}`);
  if (q.search !== undefined) {
    // Both sides are lower-cased, so SQLite's ASCII case-folding LIKE is exact too.
    where.push(`e.search LIKE ${p(`%${escapeLike(q.search)}%`)} ESCAPE '!'`);
  }
  if (q.after) {
    const op = q.order === "desc" ? "<" : ">";
    const at = p(q.after.occurredAt);
    const at2 = p(q.after.occurredAt);
    const id = p(q.after.id);
    where.push(`(e.occurred_at ${op} ${at} OR (e.occurred_at = ${at2} AND e.id ${op} ${id}))`);
  }
  const dir = q.order === "desc" ? "DESC" : "ASC";
  const sql =
    `SELECT e.data AS data FROM ${names.events} e` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY e.occurred_at ${dir}, e.id ${dir} LIMIT ${p(q.limit + 1)}`;
  return { sql, args };
}

/** Split `limit + 1` rows into the page and the `hasMore` flag. */
export function toQueryResult(
  rows: Array<{ data?: unknown }>,
  limit: number,
): { items: AuditEvent[]; hasMore: boolean } {
  return {
    items: rows.slice(0, limit).map((r) => parseEvent(r.data)),
    hasMore: rows.length > limit,
  };
}

/** The {@link EventLogStorage} methods (no KV) — what SQL drivers spread in. */
export type EventLogMethods = Omit<
  EventLogStorage,
  "getItem" | "setItem" | "removeItem" | "getKeys"
>;
