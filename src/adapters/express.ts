/**
 * Express adapter. Express predates the web Fetch API, so {@link auditPanel}
 * bridges Node's `req`/`res` to the web-standard handler: it builds a
 * `Request` from the incoming message, runs {@link createFetchHandler}, and
 * **streams** the `Response` back (exports are never buffered in memory). No
 * `express` import at runtime — only its types. {@link auditContext} is the
 * request-context middleware (ADR 0013).
 *
 * Mount the panel BEFORE any body-parser middleware (it reads the raw body):
 *
 * ```ts
 * import express from "express";
 * import { auditContext, auditPanel } from "@xtandard/audit/express";
 * const app = express();
 * app.use(auditContext({ actor: (req) => req.user, tenant: (req) => req.user?.orgId }));
 * app.use("/audit", auditPanel({ basePath: "/audit", storage }));
 * ```
 *
 * The panel starts the stream runner when `streams` are declared; pass
 * `streamRunner: false` for split deployments.
 *
 * @module
 */

import type { NextFunction, Request as ExRequest, Response as ExResponse } from "express";
import { toExpressMiddleware } from "@xtandard/kit/adapters/express";
import { headersFrom, requestUrl } from "@xtandard/kit/adapters/node";
import { runWithAuditContext } from "../context.ts";
import { createFetchHandler, type AuditPanelOptions } from "../server/create-fetch-handler.ts";
import { resolveAuditScope, type AuditContextOptions } from "./context-shared.ts";

/** An Express request handler with the `core` + `streams` + `openapi` + `close` attached. */
export type ExpressAuditHandler = ((
  req: ExRequest,
  res: ExResponse,
  next: NextFunction,
) => void) & {
  core: ReturnType<typeof createFetchHandler>["core"];
  streams: ReturnType<typeof createFetchHandler>["streams"];
  openapi: ReturnType<typeof createFetchHandler>["openapi"];
  close: ReturnType<typeof createFetchHandler>["close"];
};

/** Create an Express handler serving the panel. Use with `app.use(path, handler)`. */
export function auditPanel(options: AuditPanelOptions): ExpressAuditHandler {
  const handler = createFetchHandler(options);

  // The kit's Node bridge: every Set-Cookie kept, multi-value headers appended,
  // pre-parsed bodies re-serialised, responses (exports) streamed with
  // backpressure and cancelled when the client goes away.
  const middleware = toExpressMiddleware(handler.fetch);

  return Object.assign(middleware, {
    core: handler.core,
    streams: handler.streams,
    openapi: handler.openapi,
    close: handler.close,
  });
}

/**
 * Request-context middleware: resolves the actor / tenant from Express's
 * `req` (whatever your auth middleware set, e.g. `req.user`) and calls
 * `next()` inside an audit context scope, so every `audit.record()` in the
 * downstream handlers is attributed. The socket address is the IP fallback.
 */
export function auditContext(
  options: AuditContextOptions<ExRequest> = {},
): (req: ExRequest, res: ExResponse, next: NextFunction) => void {
  return (req, _res, next) => {
    // Headers only — the body stays untouched for downstream parsers.
    const request = new Request(requestUrl(req), { headers: headersFrom(req) });
    resolveAuditScope(request, req, options, req.socket?.remoteAddress ?? null).then(
      (scope) => runWithAuditContext(scope, () => next()),
      next,
    );
  };
}

export type { AuditContextOptions, AuditPanelOptions };
