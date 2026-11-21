/**
 * Framework-independent half of the `auditContext()` middlewares (ADR 0013):
 * the options every adapter accepts and the resolution of an {@link AuditScope}
 * from a web-standard `Request` plus the framework's own context object.
 * Must not import any framework.
 *
 * @module
 */

import {
  auditContextFromRequest,
  type AuditScope,
  type RequestContextOptions,
} from "../context.ts";
import type { AuditActor, AuditContext } from "../schema.ts";

type MaybePromise<T> = T | Promise<T>;

/**
 * Options for every framework's `auditContext()` middleware. The callbacks
 * receive the framework's own request context (Hono's `c`, Express's `req`,
 * Elysia's `ctx`, Bun's `Request`) so they can read whatever the host's auth
 * already resolved (a session, a decoded JWT, `req.user`, …).
 */
export interface AuditContextOptions<Ctx> {
  /** Resolve the actor for events recorded in this request (or nothing). */
  actor?: (ctx: Ctx) => MaybePromise<AuditActor | null | undefined>;
  /** Resolve the tenant for events recorded in this request (or nothing). */
  tenant?: (ctx: Ctx) => MaybePromise<string | null | undefined>;
  /** Extra context keys merged over the captured IP / user agent / request id. */
  context?: (ctx: Ctx) => MaybePromise<AuditContext | null | undefined>;
  /**
   * Trust proxy headers (`x-forwarded-for`, `cf-connecting-ip`, `x-real-ip`,
   * `fly-client-ip`) for the client IP. Default `true` — set `false` when the
   * app is reachable directly, or clients can spoof their IP.
   */
  trustProxy?: boolean;
  /** Header carrying the request id. Default: `x-request-id`, then `cf-ray`. */
  requestIdHeader?: string;
}

/**
 * Build the scope for one request: IP / user agent / request id from the
 * headers (with `ip` as the socket-level fallback), then the host's actor,
 * tenant and extra context.
 */
export async function resolveAuditScope<Ctx>(
  request: Request,
  ctx: Ctx,
  options: AuditContextOptions<Ctx>,
  ip?: string | null,
): Promise<AuditScope> {
  const reqOptions: RequestContextOptions = {
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.requestIdHeader ? { requestIdHeader: options.requestIdHeader } : {}),
    ...(ip ? { ip } : {}),
  };
  const [actor, tenant, extra] = await Promise.all([
    options.actor?.(ctx),
    options.tenant?.(ctx),
    options.context?.(ctx),
  ]);
  return {
    context: { ...auditContextFromRequest(request, reqOptions), ...extra },
    ...(actor ? { actor } : {}),
    ...(tenant ? { tenant } : {}),
  };
}
