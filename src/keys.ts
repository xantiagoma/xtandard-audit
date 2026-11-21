/**
 * Storage key layout for `@xtandard/audit`.
 *
 * Control data always lives in these KV keys. Events live here too on drivers
 * without the native {@link ./storage/contract.EventLogStorage} capability (the
 * generic fallback, ADR 0005). Pure string helpers — no dependencies.
 *
 * ```txt
 * aud/tenants                                          -> string[] index
 * aud/actions                                          -> string[] index (catalog)
 * aud/actions/{name}                                   -> ActionDefinition
 * aud/t/{tenant}/head                                  -> ChainHead
 * aud/t/{tenant}/checkpoints/{chk id}                  -> AuditCheckpoint (time-sortable id)
 * aud/streams/{stream}/cursors/{tenant}                -> StreamCursor
 * aud/streams/{stream}/meta                            -> { startedAt }
 * aud/streams/{stream}/lease                           -> StreamLease
 *
 * — generic event log (KV fallback only) —
 * aud/t/{tenant}/events/{seq 12}                       -> AuditEvent
 * aud/t/{tenant}/ids/{event id}                        -> seq
 * aud/t/{tenant}/ix/time/{ms 13}~{id}                  -> seq
 * aud/t/{tenant}/ix/actor/{actorId}/{ms 13}~{id}       -> seq
 * aud/t/{tenant}/ix/action/{action}/{ms 13}~{id}       -> seq
 * aud/t/{tenant}/ix/target/{type}/{id}/{ms 13}~{id}    -> seq
 * ```
 *
 * Zero-padded numbers make lexicographic key order equal numeric order, so a
 * sorted `getKeys` scan yields events by seq (or by occurredAt for the `ix/`
 * indexes) on every backend. Free-form segments (tenant, actor id, action,
 * target type/id) are `encodeURIComponent`-escaped so `/` and `~` cannot break
 * the layout.
 *
 * @module
 */

/** Root namespace segment for all keys. */
export const ROOT = "aud";

const enc = (segment: string) => encodeURIComponent(segment).replace(/~/g, "%7E");

/** Zero-pad a seq to 12 digits. */
export const padSeq = (seq: number) => String(seq).padStart(12, "0");
/** Zero-pad epoch millis to 13 digits. */
export const padMs = (ms: number) => String(Math.max(0, ms)).padStart(13, "0");

/** Index of all tenant keys. */
export const tenantsKey = () => `${ROOT}/tenants`;
/** Action catalog index. */
export const actionsKey = () => `${ROOT}/actions`;
/** One action catalog entry. */
export const actionKey = (name: string) => `${ROOT}/actions/${enc(name)}`;

/** Prefix under which everything belonging to one tenant lives. */
export const tenantPrefix = (tenant: string) => `${ROOT}/t/${enc(tenant)}/`;
/** The tenant's chain head. */
export const headKey = (tenant: string) => `${tenantPrefix(tenant)}head`;
/** Prefix of the tenant's checkpoints. */
export const checkpointsPrefix = (tenant: string) => `${tenantPrefix(tenant)}checkpoints/`;
/** One checkpoint. */
export const checkpointKey = (tenant: string, id: string) => `${checkpointsPrefix(tenant)}${id}`;

/** Prefix of a stream's per-tenant cursors. */
export const streamCursorsPrefix = (stream: string) => `${ROOT}/streams/${enc(stream)}/cursors/`;
/** One stream cursor. */
export const streamCursorKey = (stream: string, tenant: string) =>
  `${streamCursorsPrefix(stream)}${enc(tenant)}`;
/** A stream's metadata (first-run marker). */
export const streamMetaKey = (stream: string) => `${ROOT}/streams/${enc(stream)}/meta`;
/** A stream's runner lease. */
export const streamLeaseKey = (stream: string) => `${ROOT}/streams/${enc(stream)}/lease`;

// ---- generic event log (KV fallback) ----------------------------------------------------------

/** Prefix of the tenant's events (by seq). */
export const eventsPrefix = (tenant: string) => `${tenantPrefix(tenant)}events/`;
/** One event, keyed by seq. */
export const eventKey = (tenant: string, seq: number) => `${eventsPrefix(tenant)}${padSeq(seq)}`;
/** Event id → seq. */
export const eventIdKey = (tenant: string, id: string) => `${tenantPrefix(tenant)}ids/${id}`;

/** Prefix of a tenant's secondary indexes. */
export const indexRoot = (tenant: string) => `${tenantPrefix(tenant)}ix/`;
/** Time index prefix. */
export const timeIndexPrefix = (tenant: string) => `${indexRoot(tenant)}time/`;
/** Actor index prefix. */
export const actorIndexPrefix = (tenant: string, actorId: string) =>
  `${indexRoot(tenant)}actor/${enc(actorId)}/`;
/** Action index prefix. */
export const actionIndexPrefix = (tenant: string, action: string) =>
  `${indexRoot(tenant)}action/${enc(action)}/`;
/** Target index prefix. */
export const targetIndexPrefix = (tenant: string, type: string, id: string) =>
  `${indexRoot(tenant)}target/${enc(type)}/${enc(id)}/`;

/** The `{ms}~{id}` leaf of every index key. */
export const indexLeaf = (occurredAtMs: number, id: string) => `${padMs(occurredAtMs)}~${id}`;

/** Parse an index key's leaf back into `(occurredAtMs, id)`. */
export const parseIndexLeaf = (key: string): { ms: number; id: string } | null => {
  const leaf = lastSegment(key);
  const sep = leaf.indexOf("~");
  if (sep === -1) return null;
  const ms = Number(leaf.slice(0, sep));
  const id = leaf.slice(sep + 1);
  if (!Number.isFinite(ms) || id.length === 0) return null;
  return { ms, id };
};

/** Parse a seq from an event key. */
export const parseEventKey = (key: string): number | null => {
  const n = Number(lastSegment(key));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Extract the trailing segment from a key. */
export const lastSegment = (key: string): string => {
  const parts = key.split("/");
  return parts[parts.length - 1] ?? "";
};

/** Decode an escaped key segment. */
export const decodeSegment = (segment: string): string => decodeURIComponent(segment);
