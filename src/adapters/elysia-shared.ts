/**
 * Elysia-version-agnostic pieces shared by the 1.x (`./elysia.ts`) and 2.x
 * (`./elysia2.ts`) adapters. Must not import `elysia`: each adapter's types are
 * built against a different major.
 *
 * @module
 */

import { createFetchHandler, type AuditPanelOptions } from "../server/create-fetch-handler.ts";

/** A web-standard fetch handler with `core` + `streams` + `openapi()` + `close()` attached. */
export type ElysiaAuditHandler = ((request: Request) => Promise<Response>) & {
  core: ReturnType<typeof createFetchHandler>["core"];
  streams: ReturnType<typeof createFetchHandler>["streams"];
  openapi: ReturnType<typeof createFetchHandler>["openapi"];
  close: ReturnType<typeof createFetchHandler>["close"];
};

/** Create a panel handler suitable for `Elysia.mount(path, handler)`. */
export function auditPanel(options: AuditPanelOptions): ElysiaAuditHandler {
  const handler = createFetchHandler(options);
  const fn = ((request: Request) => handler.fetch(request)) as ElysiaAuditHandler;
  fn.core = handler.core;
  fn.streams = handler.streams;
  fn.openapi = handler.openapi;
  fn.close = handler.close;
  return fn;
}

/** Options for `auditElysia`. */
export interface AuditElysiaOptions extends AuditPanelOptions {
  /** Mount prefix; also used as the panel basePath. Default `"/audit"`. */
  prefix?: string;
}

/**
 * Build the handler every declared route delegates to. Elysia parses the body
 * for declared routes, draining the stream; rebuild the Request from the parsed
 * body before delegating (mirrors the Express adapter).
 */
export function createPass(options: AuditElysiaOptions): {
  prefix: string;
  handler: ReturnType<typeof createFetchHandler>;
  pass: (ctx: { request: Request; body?: unknown }) => Promise<Response>;
} {
  const prefix = options.prefix ?? "/audit";
  const handler = createFetchHandler({ ...options, basePath: options.basePath ?? prefix });

  const pass = (ctx: { request: Request; body?: unknown }): Promise<Response> => {
    const r = ctx.request;
    if ((r.method === "POST" || r.method === "PUT") && r.bodyUsed) {
      const body = ctx.body;
      const parsed = body !== undefined && body !== null && body !== "";
      const headers = new Headers(r.headers);
      headers.delete("content-length");
      return handler.fetch(
        new Request(r.url, {
          method: r.method,
          headers,
          ...(parsed ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
        }),
      );
    }
    return handler.fetch(r);
  };

  return { prefix, handler, pass };
}

export type { AuditPanelOptions };
