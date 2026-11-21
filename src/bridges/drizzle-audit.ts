/**
 * The `drizzle-audit` bridge (ADR 0009): `drizzle-audit` captures row-level
 * database changes; this turns them into tenant-scoped, hash-chained audit
 * events.
 *
 * - {@link createDrizzleAuditStorage} returns an object that structurally
 *   satisfies drizzle-audit's `AuditStorage` (`write`, `flush`, `close`) — pass
 *   it as `withDrizzleAudit(db, { storage })`.
 * - {@link importDrizzleAuditEntries} imports historical rows (e.g. from a
 *   `drizzleTableStorage` table) in timestamp order.
 *
 * Mapping (overridable): `action` = `db.<table>.<insert|update|delete>`
 * (lower-cased; custom actions such as `trackAction` keep their name),
 * `targets` = `[{ type: table, id: rowId }]`, `actor.id` = `userId`,
 * `metadata` = `{ changes, oldData, newData }` (+ `extra` for
 * the context metadata that is not `ip` / `userAgent` / `requestId`), and
 * `context` = `{ ip, userAgent, requestId }` from the entry's metadata.
 *
 * The tenant is the bridge's `tenant` option when given, else drizzle-audit's
 * `entry.tenantId` (newer releases), else `entry.metadata.tenantId` (0.1.x
 * convention), else the ambient audit context's tenant.
 *
 * Each event id is derived from the entry's **content** (timestamp, table,
 * action, row id, user, changes, old/new data, metadata) — not from `entry.id`, which
 * `drizzleTableStorage` does not persist (stored rows get a fresh id). So the
 * same change forwarded live and later imported from the table maps to the same
 * event, and re-writing or re-importing is a no-op, as long as the database
 * keeps the timestamp's millisecond precision.
 *
 * Typed structurally — **no dependency** on `drizzle-audit` in either direction.
 *
 * @module
 */

import type { AuditCore, RecordInput } from "../core.ts";
import { getAuditContext } from "../context.ts";
import type { Recorder } from "../recorder.ts";
import type { AuditActor, AuditContext, AuditEvent, AuditTarget, JsonObject } from "../schema.ts";
import type { ActionMap } from "../standard-schema.ts";
import { ACTION_REGEX } from "../validation.ts";

/**
 * drizzle-audit's `AuditEntry`, structurally. `timestamp` also accepts a
 * string/number so rows read back from any driver can be imported.
 */
export interface DrizzleAuditEntry {
  id: string | number;
  tableName: string | null;
  action: string;
  rowId: string | null;
  changes: Record<string, unknown> | null;
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  timestamp: Date | string | number;
  userId: string | null;
  metadata: Record<string, unknown> | null;
  /** The entry's tenant (drizzle-audit releases after 0.1.13). */
  tenantId?: string | null;
}

/** drizzle-audit's `AuditStorage`, structurally. */
export interface DrizzleAuditStorageLike {
  write(entries: DrizzleAuditEntry[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** How a drizzle-audit entry maps to an audit event. */
export interface DrizzleAuditMapping {
  /**
   * The tenant of an entry: a fixed key, or a function. Return `null` /
   * `undefined` (or omit the option) to fall back to `entry.tenantId`, then
   * `entry.metadata.tenantId`, then the ambient audit context's tenant;
   * entries with no tenant at all throw.
   */
  tenant?: string | ((entry: DrizzleAuditEntry) => string | null | undefined);
  /** Override the action name. Default: see the module docs. */
  action?: (entry: DrizzleAuditEntry) => string;
  /**
   * Override the actor. Default: `{ id: userId, type: "user" }`, else the
   * ambient context's actor, else `{ id: "system", type: "system" }`.
   */
  actor?: (entry: DrizzleAuditEntry) => AuditActor;
  /** Override the targets. Default: `[{ type: tableName, id: rowId }]` (none without both). */
  targets?: (entry: DrizzleAuditEntry) => AuditTarget[];
  /** Only forward entries for which this returns `true` (default: all). */
  include?: (entry: DrizzleAuditEntry) => boolean;
}

/** Options for {@link createDrizzleAuditStorage}. */
export interface DrizzleAuditStorageOptions extends DrizzleAuditMapping {
  /**
   * Send through a buffered recorder instead of `core.recordMany` (ADR 0002):
   * `write` returns immediately and `flush` / `close` drain the recorder.
   * Default: synchronous commit, so drizzle-audit's `onError` sees failures.
   */
  recorder?: Recorder;
}

/** Context keys lifted from `entry.metadata` into the event's `context`. */
const CONTEXT_KEYS = ["ip", "userAgent", "requestId"] as const;
const CRUD = new Set(["INSERT", "UPDATE", "DELETE"]);

/** Make any value JSON-safe (Dates → ISO via `toJSON`, bigints → strings, `undefined` dropped). */
function toJson<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;
}

/** A table name as an action segment: lower-cased, unsupported characters → `_`. */
function actionSegment(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

/** The default action of an entry. */
export function defaultDrizzleAuditAction(entry: DrizzleAuditEntry): string {
  if (entry.tableName !== null && CRUD.has(entry.action.toUpperCase())) {
    return `db.${actionSegment(entry.tableName)}.${entry.action.toLowerCase()}`;
  }
  if (ACTION_REGEX.test(entry.action)) return entry.action;
  return entry.action.replace(/[^a-zA-Z0-9._:-]+/g, "_").replace(/^[^a-zA-Z0-9]+/, "") || "custom";
}

function entryTime(entry: DrizzleAuditEntry): number {
  const t =
    entry.timestamp instanceof Date
      ? entry.timestamp.getTime()
      : new Date(entry.timestamp).getTime();
  if (Number.isNaN(t)) throw new TypeError(`drizzle-audit entry ${entry.id}: invalid timestamp`);
  return t;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A deterministic, time-sortable event id for an entry: the entry timestamp
 * (48 bits, like every `evt_` id) followed by 80 bits of SHA-256 over the
 * entry's content (not `entry.id`, which stored rows do not keep) — so the same
 * change always maps to the same event, live or imported.
 */
export async function drizzleAuditEventId(entry: DrizzleAuditEntry): Promise<string> {
  let ms = entryTime(entry);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `drizzle-audit:${JSON.stringify([
          entryTime(entry),
          entry.tableName,
          entry.action,
          entry.rowId === null ? null : String(entry.rowId),
          entry.userId,
          toJson(entry.changes),
          toJson(entry.oldData),
          toJson(entry.newData),
          toJson(entry.metadata),
        ])}`,
      ),
    ),
  );
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD[digest[i]! % 32];
  return `evt_${time}${random}`;
}

/**
 * Map one entry to a record input (exported for custom pipelines and tests).
 * Returns `null` when `include` rejects the entry.
 */
export async function drizzleAuditEntryToInput(
  entry: DrizzleAuditEntry,
  mapping: DrizzleAuditMapping,
): Promise<RecordInput | null> {
  if (mapping.include && !mapping.include(entry)) return null;
  const scope = getAuditContext();
  const metaTenant = entry.metadata?.tenantId;
  const tenant =
    (typeof mapping.tenant === "function" ? mapping.tenant(entry) : mapping.tenant) ??
    entry.tenantId ??
    (typeof metaTenant === "string" ? metaTenant : undefined) ??
    scope?.tenant;
  if (!tenant) {
    throw new TypeError(
      `drizzle-audit entry ${entry.id}: no tenant (set the bridge's tenant option or an audit context)`,
    );
  }
  const actor: AuditActor = mapping.actor
    ? mapping.actor(entry)
    : entry.userId
      ? { id: entry.userId, type: "user" }
      : (scope?.actor ?? { id: "system", type: "system" });
  const targets: AuditTarget[] = mapping.targets
    ? mapping.targets(entry)
    : entry.tableName !== null && entry.rowId !== null
      ? [{ type: entry.tableName, id: String(entry.rowId) }]
      : [];

  const context: AuditContext = {};
  const extra: JsonObject = {};
  for (const [key, value] of Object.entries(toJson(entry.metadata) ?? {})) {
    if ((CONTEXT_KEYS as readonly string[]).includes(key) && typeof value === "string") {
      context[key] = value;
    } else if (value !== undefined) {
      extra[key] = value as JsonObject[string];
    }
  }
  const metadata: JsonObject = {
    changes: toJson(entry.changes) as JsonObject | null,
    oldData: toJson(entry.oldData) as JsonObject | null,
    newData: toJson(entry.newData) as JsonObject | null,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  return {
    id: await drizzleAuditEventId(entry),
    tenant,
    action: (mapping.action ?? defaultDrizzleAuditAction)(entry),
    occurredAt: new Date(entryTime(entry)).toISOString(),
    actor,
    targets,
    context,
    metadata,
  };
}

/**
 * Create a drizzle-audit `AuditStorage` that records into an audit core.
 *
 * @example
 * ```ts
 * import { withDrizzleAudit } from "drizzle-audit";
 * import { createDrizzleAuditStorage } from "@xtandard/audit/drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: createDrizzleAuditStorage(audit, {
 *     // tenant from drizzle-audit's context metadata
 *     tenant: (entry) => entry.metadata?.tenantId as string,
 *   }),
 *   onError: "throw", // the DB write fails if the audit event cannot be recorded
 * });
 * ```
 */
export function createDrizzleAuditStorage<A extends ActionMap>(
  core: AuditCore<A>,
  options: DrizzleAuditStorageOptions,
): DrizzleAuditStorageLike {
  return {
    async write(entries) {
      const inputs: RecordInput[] = [];
      for (const entry of entries) {
        const input = await drizzleAuditEntryToInput(entry, options);
        if (input) inputs.push(input);
      }
      if (inputs.length === 0) return;
      if (options.recorder) {
        for (const input of inputs) options.recorder.record(input);
        return;
      }
      await core.recordMany(inputs as RecordInput<A>[]);
    },
    async flush() {
      await options.recorder?.flush();
    },
    async close() {
      await options.recorder?.flush();
    },
  };
}

/** Options for {@link importDrizzleAuditEntries}. */
export interface ImportDrizzleAuditOptions extends DrizzleAuditMapping {
  /** Events per `recordMany` call. Default 500. */
  batchSize?: number;
  /** Progress callback after each committed batch. */
  onProgress?: (imported: number, total: number) => void;
}

/**
 * Import historical drizzle-audit rows (migration, ADR 0009 §4). Rows are
 * sorted by timestamp (then id) and chained in that order with `occurredAt`
 * = the entry timestamp. Re-running an import is a no-op for rows already
 * imported (deterministic event ids). Resolves to the recorded events.
 *
 * @example
 * ```ts
 * import { importDrizzleAuditEntries } from "@xtandard/audit/drizzle-audit";
 *
 * const rows = await db.select().from(auditLog);
 * await importDrizzleAuditEntries(audit, rows, {
 *   tenant: (row) => (row.metadata?.tenantId as string) ?? "legacy",
 * });
 * ```
 */
export async function importDrizzleAuditEntries<A extends ActionMap>(
  core: AuditCore<A>,
  rows: Iterable<DrizzleAuditEntry>,
  mapping: ImportDrizzleAuditOptions,
): Promise<AuditEvent[]> {
  const batchSize = mapping.batchSize ?? 500;
  const sorted = [...rows].sort((a, b) => {
    const d = entryTime(a) - entryTime(b);
    if (d !== 0) return d;
    const ai = String(a.id);
    const bi = String(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  const inputs: RecordInput[] = [];
  for (const row of sorted) {
    const input = await drizzleAuditEntryToInput(row, mapping);
    if (input) inputs.push(input);
  }
  const out: AuditEvent[] = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    out.push(...(await core.recordMany(inputs.slice(i, i + batchSize) as RecordInput<A>[])));
    mapping.onProgress?.(out.length, inputs.length);
  }
  return out;
}
