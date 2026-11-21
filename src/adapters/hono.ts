/**
 * Hono adapter. {@link auditPanel} returns a `Hono` instance whose catch-all
 * delegates to the web-standard panel handler, so it composes via
 * `app.route(path, panel)` (responses — including export streams — pass
 * through untouched). {@link auditContext} is the request-context middleware
 * (ADR 0013). The panel starts the stream runner when `streams` are declared;
 * pass `streamRunner: false` for split deployments.
 *
 * ```ts
 * import { auditContext, auditPanel } from "@xtandard/audit/hono";
 *
 * app.use("*", auditContext({ actor: (c) => c.get("user"), tenant: (c) => c.get("user")?.orgId }));
 * app.route("/audit", auditPanel({ basePath: "/audit", storage }));
 * ```
 *
 * @module
 */

import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { runWithAuditContext } from "../context.ts";
import { createFetchHandler, type AuditPanelOptions } from "../server/create-fetch-handler.ts";
import { resolveAuditScope, type AuditContextOptions } from "./context-shared.ts";

/**
 * Create a Hono sub-app serving the panel. The `core`, the `streams` runner
 * (or `null`), the `openapi()` document builder and `close()` are attached.
 */
export function auditPanel(options: AuditPanelOptions): Hono & {
  core: ReturnType<typeof createFetchHandler>["core"];
  streams: ReturnType<typeof createFetchHandler>["streams"];
  openapi: ReturnType<typeof createFetchHandler>["openapi"];
  close: ReturnType<typeof createFetchHandler>["close"];
} {
  const handler = createFetchHandler(options);
  const app = new Hono();
  app.all("*", (c) => handler.fetch(c.req.raw));
  return Object.assign(app, {
    core: handler.core,
    streams: handler.streams,
    openapi: handler.openapi,
    close: handler.close,
  });
}

/**
 * Request-context middleware: resolves the actor / tenant from Hono's context
 * (whatever your auth middleware set) and runs the rest of the chain inside
 * an audit context scope, so every `audit.record()` downstream is attributed.
 */
export function auditContext(options: AuditContextOptions<Context> = {}): MiddlewareHandler {
  return async (c, next) => {
    const scope = await resolveAuditScope(c.req.raw, c, options);
    await runWithAuditContext(scope, () => next());
  };
}

export type { AuditContextOptions, AuditPanelOptions };
