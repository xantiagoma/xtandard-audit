/**
 * Portal tokens — the credential behind the embeddable, customer-facing audit
 * log viewer (ADR 0006).
 *
 * A portal token is a compact HMAC-signed grant scoping its bearer to exactly
 * **one tenant** for a limited time, optionally narrowed by a **view filter**
 * (hide operator-only actions, or show a member only their own events). The
 * host mints tokens server-side with {@link createPortalToken} (the portal
 * secret never reaches a browser) and hands them to its frontend; the panel
 * handler verifies them with {@link verifyPortalToken}, force-scopes every
 * request to the token's tenant, and AND-s the filter into every query and
 * export (see {@link scopeQueryToPortal}).
 *
 * Wire format:
 *
 * ```txt
 * audpt_<base64url(JSON { tenant, exp, filter? })>.<base64url(HMAC-SHA256(secret, payloadPart))>
 * ```
 *
 * Zero dependencies (Web Crypto only). The portal secret is an **arbitrary
 * string** — it is fed to the HMAC as raw UTF-8 bytes.
 *
 * @module
 */

import type { AuditAction } from "./authorization/contract.ts";
import { durationToMs } from "./duration.ts";
import { base64urlDecode, base64urlEncode } from "./integrity.ts";
import { normalizeQuery, matchesQuery } from "./query.ts";
import type { AuditDuration, AuditEvent, AuditQuery } from "./schema.ts";

/** Prefix of every portal token. */
export const PORTAL_TOKEN_PREFIX = "audpt_";

const DEFAULT_EXPIRES_IN: AuditDuration = "1h";

/**
 * The default portal grant: browse, export and verify the tenant's own log,
 * and read the action catalog. Nothing mutating.
 */
export const DEFAULT_PORTAL_ACTIONS: readonly AuditAction[] = [
  "event:read",
  "event:export",
  "action:read",
  "integrity:read",
];

/**
 * A server-side view filter carried inside a portal token. Every field is
 * AND-ed into every query, export and single-event read the bearer makes; a
 * client parameter can only narrow it, never widen it.
 */
export interface PortalFilter {
  /** Only these actions (exact names or `"invoice.*"` families). */
  actions?: string[];
  /** Never these actions (exact names or families) — e.g. `["support.*"]`. */
  excludeActions?: string[];
  /** Only events by this actor (a member sees their own activity). */
  actorId?: string;
  /** Only events touching a target of this type. */
  targetType?: string;
  /** Only events touching a target with this id. */
  targetId?: string;
}

/**
 * Thrown by {@link verifyPortalToken} for any invalid token — malformed,
 * bad signature, or expired. Maps to HTTP 401 at the API layer.
 */
export class PortalTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalTokenError";
  }
}

/** Options for {@link createPortalToken}. */
export interface PortalTokenOptions {
  /** Token lifetime. Default `"1h"` (an audit portal is a read session). */
  expiresIn?: AuditDuration;
  /** Server-side view filter (see {@link PortalFilter}). */
  filter?: PortalFilter;
}

/** What a verified token grants. */
export interface PortalGrant {
  /** The tenant the token is scoped to. */
  tenant: string;
  /** Expiry, unix epoch milliseconds. */
  expiresAt: number;
  /** The token's view filter, when it has one. */
  filter?: PortalFilter;
}

/** The claims carried inside a portal token. */
interface PortalTokenClaims {
  tenant: string;
  /** Expiry, unix epoch milliseconds. */
  exp: number;
  filter?: PortalFilter;
}

/** HMAC-SHA256 keyed by the raw UTF-8 bytes of the (arbitrary-string) secret. */
async function hmac(secret: string, content: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return new Uint8Array(digest);
}

/** Constant-time byte comparison (XOR accumulate — no early exit on content). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Keep only well-formed, non-empty filter fields (or `undefined` when nothing is left). */
function cleanFilter(input: unknown): PortalFilter | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const f = input as Record<string, unknown>;
  const out: PortalFilter = {};
  if (isStringArray(f.actions) && f.actions.length) out.actions = [...f.actions];
  if (isStringArray(f.excludeActions) && f.excludeActions.length)
    out.excludeActions = [...f.excludeActions];
  for (const k of ["actorId", "targetType", "targetId"] as const) {
    if (typeof f[k] === "string" && f[k]) out[k] = f[k] as string;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Mint a portal token granting read access to `tenant`'s log until
 * `expiresIn` elapses (default 1 hour). Call this **server-side** — anyone
 * holding the portal secret can mint tokens for any tenant.
 *
 * @example
 * ```ts
 * import { createPortalToken } from "@xtandard/audit";
 *
 * // In the host app's session-guarded route:
 * const token = await createPortalToken(process.env.PORTAL_SECRET!, user.orgId, {
 *   expiresIn: "30m",
 *   filter: { excludeActions: ["support.*"] },
 * });
 * // Hand `token` to the frontend for <AuditPortal token={token} />.
 * ```
 */
export async function createPortalToken(
  secret: string,
  tenant: string,
  options: PortalTokenOptions = {},
): Promise<string> {
  if (!tenant) throw new TypeError("createPortalToken requires a tenant");
  const expiresInMs = durationToMs(options.expiresIn ?? DEFAULT_EXPIRES_IN);
  const filter = cleanFilter(options.filter);
  const claims: PortalTokenClaims = {
    tenant,
    exp: Date.now() + expiresInMs,
    ...(filter ? { filter } : {}),
  };
  const payloadPart = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = base64urlEncode(await hmac(secret, payloadPart));
  return `${PORTAL_TOKEN_PREFIX}${payloadPart}.${signature}`;
}

/**
 * Verify a portal token: format, signature (constant time), then expiry.
 * Returns the grant on success; throws {@link PortalTokenError} otherwise.
 *
 * @example
 * ```ts
 * import { verifyPortalToken } from "@xtandard/audit";
 *
 * const { tenant, filter } = await verifyPortalToken(secret, token);
 * ```
 */
export async function verifyPortalToken(secret: string, token: string): Promise<PortalGrant> {
  if (!token.startsWith(PORTAL_TOKEN_PREFIX)) {
    throw new PortalTokenError("Invalid portal token: missing audpt_ prefix");
  }
  const parts = token.slice(PORTAL_TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PortalTokenError("Invalid portal token: malformed");
  }
  const [payloadPart, signaturePart] = parts as [string, string];

  // Signature first: never interpret unauthenticated claims.
  let candidate: Uint8Array;
  try {
    candidate = base64urlDecode(signaturePart);
  } catch {
    throw new PortalTokenError("Invalid portal token: malformed signature");
  }
  const expected = await hmac(secret, payloadPart);
  if (!timingSafeEqual(expected, candidate)) {
    throw new PortalTokenError("Invalid portal token: signature mismatch");
  }

  let claims: PortalTokenClaims;
  try {
    claims = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadPart)),
    ) as PortalTokenClaims;
  } catch {
    throw new PortalTokenError("Invalid portal token: malformed payload");
  }
  if (typeof claims.tenant !== "string" || claims.tenant.length === 0) {
    throw new PortalTokenError("Invalid portal token: missing tenant");
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new PortalTokenError("Invalid portal token: missing expiry");
  }
  if (Date.now() >= claims.exp) {
    throw new PortalTokenError("Portal token has expired");
  }
  const filter = cleanFilter(claims.filter);
  return { tenant: claims.tenant, expiresAt: claims.exp, ...(filter ? { filter } : {}) };
}

// ---- filter narrowing --------------------------------------------------------------------------

/** An action pattern: exact name, or a family prefix (`"invoice."` for `"invoice.*"`, `""` for `"*"`). */
type Pattern = { exact: string } | { prefix: string };

function toPattern(raw: string): Pattern {
  const a = raw.trim();
  if (a === "*") return { prefix: "" };
  if (a.endsWith("*")) return { prefix: a.slice(0, -1) };
  return { exact: a };
}

const fromPattern = (p: Pattern): string => ("exact" in p ? p.exact : `${p.prefix}*`);

/** Does pattern `outer` include everything pattern `inner` matches? */
function covers(outer: Pattern, inner: Pattern): boolean {
  if ("exact" in outer) return "exact" in inner && inner.exact === outer.exact;
  return "exact" in inner
    ? inner.exact.startsWith(outer.prefix)
    : inner.prefix.startsWith(outer.prefix);
}

/**
 * Intersect two action include-lists (each an OR of exact names and families).
 * Returns the narrowest list matching exactly what both match; `[]` means
 * "nothing matches".
 */
export function intersectActions(a: string[], b: string[]): string[] {
  const pa = a.map(toPattern);
  const pb = b.map(toPattern);
  const out = new Set<string>();
  for (const x of pa) if (pb.some((y) => covers(y, x))) out.add(fromPattern(x));
  for (const y of pb) if (pa.some((x) => covers(x, y))) out.add(fromPattern(y));
  return [...out];
}

/** The result of applying a portal filter to a client query. */
export type ScopedQuery =
  /** The query to run (tenant forced, filter AND-ed in). */
  | { query: AuditQuery; empty: false }
  /** The client asked for something outside the token's view: the answer is an empty result. */
  | { query: AuditQuery; empty: true };

/**
 * Force a client query into a portal grant: the tenant is the token's, and
 * every filter field is AND-ed in. A client parameter can only **narrow** the
 * view — action lists are intersected, exclusions are unioned, and a client
 * `actorId` / `targetType` / `targetId` that differs from the token's makes
 * the result empty (`empty: true`) instead of widening it.
 *
 * @example
 * ```ts
 * const { query, empty } = scopeQueryToPortal(clientQuery, grant);
 * const page = empty ? { items: [], pageInfo: { hasNextPage: false, endCursor: null } } : await audit.query(query);
 * ```
 */
export function scopeQueryToPortal(query: AuditQuery, grant: PortalGrant): ScopedQuery {
  const filter = grant.filter ?? {};
  let empty = query.tenant !== undefined && query.tenant !== grant.tenant;
  const scoped: AuditQuery = { ...query, tenant: grant.tenant };

  if (filter.actions?.length) {
    if (query.actions?.length) {
      const both = intersectActions(query.actions, filter.actions);
      if (both.length === 0) empty = true;
      scoped.actions = both.length ? both : [...filter.actions];
    } else {
      scoped.actions = [...filter.actions];
    }
  }
  if (filter.excludeActions?.length) {
    scoped.excludeActions = [
      ...new Set([...(query.excludeActions ?? []), ...filter.excludeActions]),
    ];
  }
  for (const k of ["actorId", "targetType", "targetId"] as const) {
    const forced = filter[k];
    if (forced === undefined) continue;
    if (query[k] !== undefined && query[k] !== forced) empty = true;
    scoped[k] = forced;
  }
  return { query: scoped, empty };
}

/** Is `event` inside the grant's view (its tenant, and its filter)? */
export function portalCanSee(event: AuditEvent, grant: PortalGrant): boolean {
  if (event.tenant !== grant.tenant) return false;
  if (!grant.filter) return true;
  return matchesQuery(event, normalizeQuery(scopeQueryToPortal({}, grant).query));
}
