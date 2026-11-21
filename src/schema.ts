/**
 * Core type definitions for `@xtandard/audit`.
 *
 * This module is **types only** — no runtime code beyond tiny guards and
 * constants, no dependencies. It is safe to import from the record hot path and
 * the zero-dependency verifier. Runtime validation (which pulls in `valibot`)
 * lives in {@link ./validation}.
 *
 * Import from `@xtandard/audit/schema` (also re-exported by the root).
 *
 * @module schema
 */

/** JSON-serializable value, used for metadata, context, and catalog schemas. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/**
 * A JSON object (the shape of `metadata`, `context`, and actor/target
 * metadata). `undefined` members are allowed for ergonomics and dropped on
 * serialization, exactly like `JSON.stringify`.
 */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * A duration for configuration options: either milliseconds as a number, or a
 * human-friendly string such as `"5s"`, `"30m"`, `"2h"`, `"90d"`. Parsed by
 * {@link ./duration.durationToMs}.
 */
export type AuditDuration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

/** Current schema version for stored records. */
export const SCHEMA_VERSION = 1 as const;

/** Who performed the action. `id` is required; everything else is presentational. */
export interface AuditActor {
  /** Stable identifier of the actor in the host's system (user id, API key id, …). */
  id: string;
  /** Kind of actor, e.g. `"user"`, `"api_key"`, `"system"`, `"support"`. Default `"user"`. */
  type?: string;
  /** Display name. */
  name?: string;
  /** Email, when the actor is a person. */
  email?: string;
  /** Arbitrary extra attributes. */
  metadata?: JsonObject;
}

/** A resource the action was performed on. */
export interface AuditTarget {
  /** Resource kind, e.g. `"invoice"`, `"user"`, `"team"`. */
  type: string;
  /** Stable identifier of the resource. */
  id: string;
  /** Display name. */
  name?: string;
  /** Arbitrary extra attributes. */
  metadata?: JsonObject;
}

/**
 * Where the action came from. Well-known keys are typed; any other JSON key is
 * allowed (e.g. `sessionId`, `apiVersion`).
 */
export interface AuditContext {
  /** Client IP address. */
  ip?: string;
  /** Client user agent. */
  userAgent?: string;
  /** Correlation id of the request that caused the event. */
  requestId?: string;
  /** Human-readable location (e.g. from GeoIP), if the host resolves one. */
  location?: string;
  [key: string]: JsonValue | undefined;
}

/** Outcome of the audited action. */
export type AuditOutcome = "success" | "failure";

/**
 * The privacy-bearing sections of an event. Each is hashed separately (salted
 * with the event id) so it can be erased without breaking the chain (ADR 0004,
 * ADR 0011).
 */
export type AuditSection = "actor" | "targets" | "context" | "metadata" | "description";

/** All sections, in canonical order. */
export const AUDIT_SECTIONS: readonly AuditSection[] = [
  "actor",
  "targets",
  "context",
  "metadata",
  "description",
] as const;

/** Marker that replaces the content of an erased section. */
export const ERASED_MARKER = { $erased: true } as const;

/** The tamper-evidence block carried by every stored event (ADR 0004). */
export interface AuditIntegrity {
  /** Integrity format version. */
  v: 1;
  /** The previous event's `hash` in this tenant's chain (genesis for `seq` 1, or the prune base). */
  prevHash: string;
  /** This event's chain hash: SHA-256 over the canonical header. */
  hash: string;
  /** Per-section digests, salted with the event id. */
  digests: Record<AuditSection, string>;
  /** Sections erased after the fact (their content is the erasure marker; digests are kept). */
  erased?: AuditSection[];
}

/** A stored, chained audit event. */
export interface AuditEvent {
  /** `evt_` + 26-char time-sortable id (ADR 0010). */
  id: string;
  /** The tenant (customer organization) the event belongs to. */
  tenant: string;
  /** Position in the tenant's chain: contiguous from 1. */
  seq: number;
  /** What happened, e.g. `"invoice.paid"`, `"member.role_changed"`. */
  action: string;
  /** ISO-8601: when it happened (caller-supplied, or record time). */
  occurredAt: string;
  /** ISO-8601: when the log accepted it. */
  recordedAt: string;
  actor: AuditActor;
  targets: AuditTarget[];
  context: AuditContext;
  /** Action-specific data (typed per action via `defineActions`). */
  metadata: JsonObject;
  outcome?: AuditOutcome;
  /** Optional human-readable sentence ("Alice changed Bob's role to admin"). */
  description?: string;
  integrity: AuditIntegrity;
}

/**
 * What callers pass to `record()`. Everything the log derives itself (`seq`,
 * `recordedAt`, `integrity`) is omitted; `id` and `occurredAt` are optional.
 */
export interface AuditEventInput<TAction extends string = string, TMetadata = JsonObject> {
  /** Supply your own id for idempotent re-recording (same id + same content = no-op). */
  id?: string;
  tenant: string;
  action: TAction;
  /** ISO-8601 or `Date`. Defaults to now. */
  occurredAt?: string | Date;
  /** Defaults to the ambient request context's actor (see `@xtandard/audit/context`). */
  actor?: AuditActor;
  targets?: AuditTarget[];
  /** Merged over the ambient request context (explicit keys win). */
  context?: AuditContext;
  metadata?: TMetadata;
  outcome?: AuditOutcome;
  description?: string;
}

/** A signed chain head (ADR 0004). */
export interface AuditCheckpoint {
  /** Checkpoint format version. */
  v: 1;
  /** `chk_` + time-sortable id. */
  id: string;
  tenant: string;
  /**
   * `"head"`: signs the chain head at `seq`. `"base"`: anchors a pruned prefix —
   * `hash` is the hash of the last pruned event, i.e. the `prevHash` the first
   * retained event must carry.
   */
  kind: "head" | "base";
  seq: number;
  hash: string;
  /** ISO-8601 creation time. */
  at: string;
  /** Signing key id (matches a key in the JWKS). */
  keyId: string;
  /** Signature algorithm. */
  alg: "Ed25519" | "HS256";
  /** base64url signature over the canonical checkpoint minus `signature`. */
  signature: string;
}

/** The current head of one tenant's chain. */
export interface ChainHead {
  tenant: string;
  /** Last assigned seq (0 when empty). */
  seq: number;
  /** Hash of the event at `seq` (genesis when empty). */
  hash: string;
  /** First retained seq after pruning (1 when never pruned). */
  baseSeq?: number;
  /** `prevHash` of the first retained event (genesis when never pruned). */
  baseHash?: string;
  /** ISO-8601 time of the last append. */
  updatedAt?: string;
}

/** Tenant summary for listings. */
export interface AuditTenant {
  key: string;
  /** Events currently retained. */
  count?: number;
  head: ChainHead;
  /** ISO-8601 time of the first event ever recorded. */
  createdAt?: string;
}

/** Action catalog entry (documentation + UI; schemas live in code, ADR 0012). */
export interface ActionDefinition {
  /** Dot-delimited name, e.g. `"invoice.paid"`. Allowed: `a-z A-Z 0-9 . _ - :`. */
  name: string;
  description?: string;
  /** UI grouping label (e.g. `"Billing"`). */
  group?: string;
  /** Target types this action is expected to carry. Documentation only. */
  targets?: string[];
  /** JSON-Schema-ish description of `metadata`, for the UI. Documentation only. */
  schema?: JsonValue;
  /** Flagged in the UI; still recordable. */
  deprecated?: boolean;
  /** Where this entry came from: `"code"` (`defineActions`) or `"ui"`. */
  source?: "code" | "ui";
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The query model (ADR 0007). All filters are AND-ed; list-valued filters are
 * OR-ed within themselves.
 */
export interface AuditQuery {
  /** Restrict to one tenant. Forced for portal principals. */
  tenant?: string;
  /** Exact action names, or families with a trailing `*` (`"invoice.*"`). */
  actions?: string[];
  /** Exclude these names / families. */
  excludeActions?: string[];
  actorId?: string;
  actorType?: string;
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  /** Inclusive lower bound on `occurredAt` (ISO-8601). */
  from?: string;
  /** Exclusive upper bound on `occurredAt` (ISO-8601). */
  to?: string;
  /** Case-insensitive substring over action, actor, targets, description, metadata. */
  search?: string;
  /** Sort by `(occurredAt, id)`. Default `"desc"` (newest first). */
  order?: "desc" | "asc";
  /** Page size. Default 50, max 500. */
  limit?: number;
  /** Opaque keyset cursor from a previous page's `pageInfo.endCursor`. */
  cursor?: string;
}

/**
 * One page of results — the `@xtandard/lib` `Paginated<T>` envelope shape, so a
 * host can feed it to `createPaginator({ fetchCursor })` unchanged (ADR 0007).
 */
export interface AuditPage<T = AuditEvent> {
  items: T[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}
