/**
 * Ambient request context (ADR 0013): open a scope per request with the actor,
 * tenant, IP, user agent and request id, and every `record()` inside it picks
 * them up — no threading through call sites. Pattern borrowed from
 * `drizzle-audit`'s context.
 *
 * Uses `node:async_hooks` `AsyncLocalStorage` (Bun, Node, Deno, Cloudflare
 * Workers with `nodejs_compat`). Framework adapters wrap this in an
 * `auditContext()` middleware.
 *
 * Import from `@xtandard/audit/context`.
 *
 * @module context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditActor, AuditContext } from "./schema.ts";

/** What a request scope carries. */
export interface AuditScope {
  /** Default actor for events recorded in this scope. */
  actor?: AuditActor;
  /** Default tenant for events recorded in this scope. */
  tenant?: string;
  /** Request context merged under each event's explicit `context`. */
  context?: AuditContext;
}

// One store per process even if the module is loaded twice (dual ESM/CJS).
const ALS_KEY = Symbol.for("@xtandard/audit:context");
const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<AuditScope> | undefined>;
const storage: AsyncLocalStorage<AuditScope> = (g[ALS_KEY] ??= new AsyncLocalStorage<AuditScope>());

/** The current scope, or `null` outside any scope. Never throws. */
export function getAuditContext(): AuditScope | null {
  return storage.getStore() ?? null;
}

/**
 * Run `fn` inside a scope. Nested scopes inherit and override the outer one
 * (`context` keys merge).
 *
 * @example
 * ```ts
 * import { runWithAuditContext } from "@xtandard/audit/context";
 *
 * await runWithAuditContext({ actor: { id: user.id }, tenant: user.orgId }, () =>
 *   audit.record({ action: "invoice.paid", metadata: { invoiceId } }),
 * );
 * ```
 */
export function runWithAuditContext<T>(scope: AuditScope, fn: () => T): T {
  return storage.run(mergeScopes(getAuditContext(), scope), fn);
}

/**
 * Patch the current scope for the rest of the current async execution
 * (`enterWith` semantics) — for middleware that cannot wrap `next()`, or to
 * attach the actor once auth resolves.
 */
export function setAuditContext(patch: AuditScope): void {
  storage.enterWith(mergeScopes(getAuditContext(), patch));
}

function mergeScopes(base: AuditScope | null, patch: AuditScope): AuditScope {
  if (!base) return { ...patch };
  return {
    ...base,
    ...patch,
    ...(base.context || patch.context ? { context: { ...base.context, ...patch.context } } : {}),
  };
}

/** Options for {@link auditContextFromRequest}. */
export interface RequestContextOptions {
  /**
   * Trust proxy headers (`x-forwarded-for`, `cf-connecting-ip`, `x-real-ip`,
   * `fly-client-ip`) for the client IP. Default `true` — set `false` when the
   * app is reachable directly, or clients can spoof their IP.
   */
  trustProxy?: boolean;
  /** Header carrying the request id. Default: `x-request-id`, then `cf-ray`. */
  requestIdHeader?: string;
  /** Fallback IP when no header carries one (e.g. Bun's `server.requestIP`). */
  ip?: string;
}

/** Extract `{ ip, userAgent, requestId }` from a web-standard Request. */
export function auditContextFromRequest(
  request: Request,
  options: RequestContextOptions = {},
): AuditContext {
  const h = request.headers;
  const ctx: AuditContext = {};
  if (options.trustProxy ?? true) {
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip =
      h.get("cf-connecting-ip") ?? forwarded ?? h.get("x-real-ip") ?? h.get("fly-client-ip");
    if (ip) ctx.ip = ip;
  }
  if (!ctx.ip && options.ip) ctx.ip = options.ip;
  const ua = h.get("user-agent");
  if (ua) ctx.userAgent = ua;
  const requestId = options.requestIdHeader
    ? h.get(options.requestIdHeader)
    : (h.get("x-request-id") ?? h.get("cf-ray"));
  if (requestId) ctx.requestId = requestId;
  return ctx;
}
