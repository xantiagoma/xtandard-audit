/**
 * Bun adapter. The handler is already web-standard, so {@link auditPanel} is a
 * passthrough you can hand straight to `Bun.serve({ fetch })`. The panel
 * starts the stream runner when `streams` are declared; pass
 * `streamRunner: false` for split deployments.
 *
 * ```ts
 * import { auditPanel, withAuditContext } from "@xtandard/audit/bun";
 * const panel = auditPanel({ storage, basePath: "/audit" });
 *
 * Bun.serve({
 *   port: 3000,
 *   // Every `audit.record()` inside `app` picks up the actor, tenant, IP, UA and request id.
 *   fetch: withAuditContext(app, {
 *     actor: async (req) => (await session(req))?.user,
 *     tenant: async (req) => (await session(req))?.orgId,
 *   }),
 * });
 * ```
 *
 * @module
 */

import { runWithAuditContext } from "../context.ts";
import {
  createFetchHandler,
  type CreateFetchHandlerResult,
  type AuditPanelOptions,
} from "../server/create-fetch-handler.ts";
import { resolveAuditScope, type AuditContextOptions } from "./context-shared.ts";

/** Create a Bun-ready panel handler (`fetch` + `core` + `streams` + `openapi`). */
export function auditPanel(options: AuditPanelOptions): CreateFetchHandlerResult {
  return createFetchHandler(options);
}

/** The subset of Bun's `Server` the context wrapper uses (for the socket IP). */
export interface BunServerLike {
  requestIP?(request: Request): { address: string } | null;
}

/** A `Bun.serve` fetch handler. */
export type BunFetch<S extends BunServerLike = BunServerLike> = (
  request: Request,
  server: S,
) => Response | Promise<Response>;

/**
 * Wrap a `Bun.serve` fetch handler so each request runs inside an audit
 * context scope (ADR 0013): `actor` / `tenant` / `context` resolve from the
 * request, and IP / user agent / request id are captured (the socket IP via
 * `server.requestIP` is the fallback when no trusted proxy header is set).
 */
export function withAuditContext<S extends BunServerLike>(
  fetch: BunFetch<S>,
  options: AuditContextOptions<Request> = {},
): BunFetch<S> {
  return async (request, server) => {
    const ip = server?.requestIP?.(request)?.address ?? null;
    const scope = await resolveAuditScope(request, request, options, ip);
    return runWithAuditContext(scope, () => fetch(request, server));
  };
}

/**
 * `auditContext(options)` → a wrapper for a `Bun.serve` fetch handler; the
 * curried form of {@link withAuditContext}, matching the other adapters' name.
 */
export function auditContext(
  options: AuditContextOptions<Request> = {},
): <S extends BunServerLike>(fetch: BunFetch<S>) => BunFetch<S> {
  return (fetch) => withAuditContext(fetch, options);
}

export type { AuditContextOptions, AuditPanelOptions, CreateFetchHandlerResult };
