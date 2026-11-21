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

function headersFrom(req: ExRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function readBody(req: ExRequest): Promise<Uint8Array | undefined> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  // If an upstream body parser already consumed the stream, re-serialize req.body.
  if (req.readableEnded) {
    const body = (req as { body?: unknown }).body;
    if (body === undefined || body === null) return undefined;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new TextEncoder().encode(text);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

function requestUrl(req: ExRequest): string {
  const protocol = req.protocol || "http";
  const host = req.get?.("host") ?? req.headers.host ?? "localhost";
  // originalUrl preserves the mount prefix (e.g. /audit/api/...) and query string.
  return `${protocol}://${host}${req.originalUrl ?? req.url ?? "/"}`;
}

function toWebRequest(req: ExRequest, body: Uint8Array | undefined): Request {
  return new Request(requestUrl(req), {
    method: req.method,
    headers: headersFrom(req),
    // Uint8Array is a valid BodyInit; the cast satisfies TS 5.7's generic typing.
    body: body as BodyInit | undefined,
  });
}

/** Write a web `Response` to Express, streaming the body chunk by chunk. */
async function writeWebResponse(res: ExResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  // Stop pulling (and release the export cursor) when the client goes away.
  const onClose = () => void reader.cancel().catch(() => undefined);
  res.once("close", onClose);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    res.end();
  } finally {
    res.off("close", onClose);
  }
}

/** Create an Express handler serving the panel. Use with `app.use(path, handler)`. */
export function auditPanel(options: AuditPanelOptions): ExpressAuditHandler {
  const handler = createFetchHandler(options);

  const middleware = (req: ExRequest, res: ExResponse, next: NextFunction): void => {
    (async () => {
      const body = await readBody(req);
      const request = toWebRequest(req, body);
      const response = await handler.fetch(request);
      await writeWebResponse(res, response);
    })().catch(next);
  };

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
