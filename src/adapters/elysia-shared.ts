/**
 * Elysia-version-agnostic pieces shared by the 1.x (`./elysia.ts`) and 2.x
 * (`./elysia2.ts`) adapters. Must not import `elysia`: each adapter's types are
 * built against a different major.
 *
 * @module
 */

import { createPass as kitCreatePass, type PassContext } from "@xtandard/kit/adapters/elysia";
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
 * for declared routes, draining the stream; the kit's `createPass` rebuilds the
 * Request from the parsed body (POST, PUT, PATCH and DELETE; CSV strings pass
 * through; a stale `content-length` is dropped) before delegating.
 */
export function createPass(options: AuditElysiaOptions): {
  prefix: string;
  handler: ReturnType<typeof createFetchHandler>;
  pass: (ctx: PassContext) => Promise<Response>;
} {
  const prefix = options.prefix ?? "/audit";
  const handler = createFetchHandler({ ...options, basePath: options.basePath ?? prefix });

  const { pass } = kitCreatePass({ prefix, fetch: handler.fetch, name: "xtandard-audit" });
  return { prefix, handler, pass };
}

export type { AuditPanelOptions };
