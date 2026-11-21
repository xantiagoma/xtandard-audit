/**
 * The query model's runtime half (ADR 0007): normalization, the opaque keyset
 * cursor, and the in-memory matcher shared by the memory driver and the generic
 * KV fallback. Native drivers compile a {@link NormalizedQuery} to their own
 * query language and must agree with {@link matchesQuery} (the conformance
 * suite checks that).
 *
 * @module
 */

import { base64urlDecode, base64urlEncode } from "./integrity.ts";
import type { AuditEvent, AuditOutcome, AuditQuery } from "./schema.ts";

/** Default page size. */
export const DEFAULT_QUERY_LIMIT = 50;
/** Maximum page size. */
export const MAX_QUERY_LIMIT = 500;

/** A keyset position: the `(occurredAt, id)` of the last item of a page. */
export interface QueryPosition {
  occurredAt: string;
  id: string;
}

/**
 * A validated, defaulted query — what storage drivers receive. List filters
 * are split into exact names and `prefix.` families; `search` is lower-cased.
 */
export interface NormalizedQuery {
  tenant?: string;
  /** Exact action names to include (OR). Empty = no constraint unless `actionPrefixes` set. */
  actions: string[];
  /** Action families (`"invoice."` for `"invoice.*"`) to include (OR with `actions`). */
  actionPrefixes: string[];
  excludeActions: string[];
  excludeActionPrefixes: string[];
  actorId?: string;
  actorType?: string;
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  from?: string;
  to?: string;
  /** Lower-cased search needle. */
  search?: string;
  order: "desc" | "asc";
  limit: number;
  /** Start strictly after this position (decoded cursor). */
  after?: QueryPosition;
}

/** Thrown for a malformed cursor or an invalid query value. Maps to HTTP 400. */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

/** Encode a keyset position as an opaque cursor. */
export function encodeCursor(position: QueryPosition): string {
  return base64urlEncode(
    new TextEncoder().encode(JSON.stringify([position.occurredAt, position.id])),
  );
}

/** Decode an opaque cursor; throws {@link QueryError} when malformed. */
export function decodeCursor(cursor: string): QueryPosition {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64urlDecode(cursor))) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { occurredAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new QueryError("Invalid cursor");
}

function splitActions(list: string[] | undefined): { exact: string[]; prefixes: string[] } {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const raw of list ?? []) {
    const a = raw.trim();
    if (!a) continue;
    if (a === "*") prefixes.push("");
    else if (a.endsWith(".*")) prefixes.push(a.slice(0, -1));
    else if (a.endsWith("*")) prefixes.push(a.slice(0, -1));
    else exact.push(a);
  }
  return { exact, prefixes };
}

function isoOrThrow(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new QueryError(`Invalid ${field}: ${value}`);
  return new Date(ms).toISOString();
}

/** Validate and default a query. */
export function normalizeQuery(query: AuditQuery = {}): NormalizedQuery {
  const include = splitActions(query.actions);
  const exclude = splitActions(query.excludeActions);
  const limitRaw = query.limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isFinite(limitRaw) || limitRaw < 1) throw new QueryError("Invalid limit");
  const order = query.order ?? "desc";
  if (order !== "desc" && order !== "asc") throw new QueryError("Invalid order");
  if (query.outcome !== undefined && query.outcome !== "success" && query.outcome !== "failure") {
    throw new QueryError("Invalid outcome");
  }
  const search = query.search?.trim().toLowerCase();
  const from = isoOrThrow(query.from, "from");
  const to = isoOrThrow(query.to, "to");
  return {
    ...(query.tenant ? { tenant: query.tenant } : {}),
    actions: include.exact,
    actionPrefixes: include.prefixes,
    excludeActions: exclude.exact,
    excludeActionPrefixes: exclude.prefixes,
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.targetId ? { targetId: query.targetId } : {}),
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(search ? { search } : {}),
    order,
    limit: Math.min(Math.floor(limitRaw), MAX_QUERY_LIMIT),
    ...(query.cursor ? { after: decodeCursor(query.cursor) } : {}),
  };
}

/** Does an action name pass the include/exclude lists? */
export function actionMatches(action: string, q: NormalizedQuery): boolean {
  const included =
    (q.actions.length === 0 && q.actionPrefixes.length === 0) ||
    q.actions.includes(action) ||
    q.actionPrefixes.some((p) => action.startsWith(p));
  if (!included) return false;
  if (q.excludeActions.includes(action)) return false;
  if (q.excludeActionPrefixes.some((p) => action.startsWith(p))) return false;
  return true;
}

/**
 * The lower-cased text `search` matches against: action, actor id/name/email,
 * target types/ids/names, description, and the JSON of metadata. Native
 * drivers store this as a denormalized column/field.
 */
export function searchText(event: AuditEvent): string {
  const parts: string[] = [event.action, event.actor.id];
  if (event.actor.name) parts.push(event.actor.name);
  if (event.actor.email) parts.push(event.actor.email);
  for (const t of event.targets) {
    parts.push(t.type, t.id);
    if (t.name) parts.push(t.name);
  }
  if (event.description) parts.push(event.description);
  parts.push(JSON.stringify(event.metadata ?? {}));
  return parts.join("\n").toLowerCase();
}

/** Compare two events by `(occurredAt, id)` ascending. */
export function compareEvents(a: QueryPosition, b: QueryPosition): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Is `event` strictly after `position` in the query's order? */
export function isAfter(
  event: QueryPosition,
  position: QueryPosition,
  order: "desc" | "asc",
): boolean {
  const c = compareEvents(event, position);
  return order === "desc" ? c < 0 : c > 0;
}

/** Does `event` satisfy every filter of `q` (ignoring pagination)? */
export function matchesQuery(event: AuditEvent, q: NormalizedQuery): boolean {
  if (q.tenant !== undefined && event.tenant !== q.tenant) return false;
  if (!actionMatches(event.action, q)) return false;
  if (q.actorId !== undefined && event.actor.id !== q.actorId) return false;
  if (q.actorType !== undefined && (event.actor.type ?? "user") !== q.actorType) return false;
  if (q.targetType !== undefined || q.targetId !== undefined) {
    const hit = event.targets.some(
      (t) =>
        (q.targetType === undefined || t.type === q.targetType) &&
        (q.targetId === undefined || t.id === q.targetId),
    );
    if (!hit) return false;
  }
  if (q.outcome !== undefined && event.outcome !== q.outcome) return false;
  if (q.from !== undefined && event.occurredAt < q.from) return false;
  if (q.to !== undefined && event.occurredAt >= q.to) return false;
  if (q.search !== undefined && !searchText(event).includes(q.search)) return false;
  return true;
}

/**
 * Apply a normalized query to an in-memory list: filter, sort, keyset, limit.
 * Used by the memory driver and the KV fallback.
 */
export function applyQuery(
  events: Iterable<AuditEvent>,
  q: NormalizedQuery,
): { items: AuditEvent[]; hasMore: boolean } {
  const matched: AuditEvent[] = [];
  for (const e of events) {
    if (!matchesQuery(e, q)) continue;
    if (q.after && !isAfter(e, q.after, q.order)) continue;
    matched.push(e);
  }
  matched.sort((a, b) => (q.order === "desc" ? compareEvents(b, a) : compareEvents(a, b)));
  return { items: matched.slice(0, q.limit), hasMore: matched.length > q.limit };
}

/** Build the page envelope from driver results. */
export function toPage(result: { items: AuditEvent[]; hasMore: boolean }) {
  const last = result.items[result.items.length - 1];
  return {
    items: result.items,
    pageInfo: {
      hasNextPage: result.hasMore,
      endCursor: last && result.hasMore ? encodeCursor(last) : null,
    },
  };
}
