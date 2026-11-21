/**
 * Elysia **2.x** adapter — same surface as `@xtandard/audit/elysia`, built
 * against Elysia 2's types and its `(path, hook, handler)` route order. Use
 * `@xtandard/audit/elysia` for Elysia 1.x.
 *
 * ```ts
 * new Elysia().mount("/audit", auditPanel({ basePath: "/audit", storage }));
 * // or, typed for Eden treaty (`@elysia/eden`):
 * const app = new Elysia().use(auditElysia({ prefix: "/audit", storage }));
 * ```
 *
 * {@link auditContext} is the request-context plugin (ADR 0013). The panel
 * starts the stream runner when `streams` are declared; pass
 * `streamRunner: false` for split deployments.
 *
 * @module
 */

import { Elysia, t, type Context } from "elysia";
import { setAuditContext, type AuditScope } from "../context.ts";
import type { BunServerLike } from "./bun.ts";
import { resolveAuditScope, type AuditContextOptions } from "./context-shared.ts";
import {
  createPass,
  auditPanel,
  type ElysiaAuditHandler,
  type AuditElysiaOptions,
  type AuditPanelOptions,
} from "./elysia-shared.ts";

export { auditPanel };
export type { ElysiaAuditHandler, AuditElysiaOptions, AuditPanelOptions, AuditContextOptions };

const tenantParams = t.Object({ tenant: t.String() });
const eventParams = t.Object({ tenant: t.String(), id: t.String() });
const nameParams = t.Object({ name: t.String() });

const eventInput = t.Object({
  id: t.Optional(t.String()),
  action: t.String(),
  occurredAt: t.Optional(t.String()),
  actor: t.Optional(t.Any()),
  targets: t.Optional(t.Array(t.Any())),
  context: t.Optional(t.Any()),
  metadata: t.Optional(t.Any()),
  outcome: t.Optional(t.Union([t.Literal("success"), t.Literal("failure")])),
  description: t.Optional(t.String()),
});

const actionInput = t.Object({
  description: t.Optional(t.String()),
  group: t.Optional(t.String()),
  targets: t.Optional(t.Array(t.String())),
  schema: t.Optional(t.Any()),
  deprecated: t.Optional(t.Boolean()),
});

/**
 * Typed Elysia plugin exposing the API so the **Eden** client can call it
 * with full path/method/param typing (`client.audit.api.tenants.get()`).
 * Routes are declared for the typed surface; every handler delegates to the
 * shared fetch pipeline (auth, authorization, portal scoping, error mapping
 * reused). A catch-all also serves the bundled UI.
 *
 * Elysia 2.x only — for Elysia 1.x import from `@xtandard/audit/elysia`.
 */
export function auditElysia(options: AuditElysiaOptions) {
  const { prefix, pass } = createPass(options);

  const tenant = "/api/tenants/:tenant";
  const event = `${tenant}/events/:id`;

  return new Elysia({ prefix, name: "xtandard-audit" })
    .get("/config", pass)
    .get("/api/config", pass)
    .get("/api/openapi.json", pass)
    .get("/api/integrity/keys", pass)
    .get("/api/overview", pass)
    .get("/api/tenants", pass)
    .get(tenant, { params: tenantParams }, pass)
    .get("/api/events", pass)
    .get(`${tenant}/events`, { params: tenantParams }, pass)
    .post(
      `${tenant}/events`,
      {
        params: tenantParams,
        body: t.Union([eventInput, t.Array(eventInput)]),
      },
      pass,
    )
    .get(event, { params: eventParams }, pass)
    .post(
      `${event}/erase`,
      {
        params: eventParams,
        body: t.Optional(
          t.Object({
            sections: t.Optional(t.Array(t.String())),
            reason: t.Optional(t.String()),
          }),
        ),
      },
      pass,
    )
    .get(`${tenant}/export`, { params: tenantParams }, pass)
    .get(`${tenant}/verify`, { params: tenantParams }, pass)
    .get(`${tenant}/checkpoints`, { params: tenantParams }, pass)
    .post(`${tenant}/checkpoints`, { params: tenantParams }, pass)
    .post(`${tenant}/prune`, { params: tenantParams }, pass)
    .post("/api/prune", pass)
    .get("/api/actions", pass)
    .put("/api/actions/:name", { params: nameParams, body: actionInput }, pass)
    .delete("/api/actions/:name", { params: nameParams }, pass)
    .get("/api/streams", pass)
    .post("/api/streams/:name/retry", { params: nameParams }, pass)
    .all("/*", pass); // bundled UI assets + SPA fallback
}

/** Elysia's request context, plus whatever the host's own plugins derived (e.g. `user`). */
export type ElysiaAuditContextCtx = Context & { [key: string]: unknown };

/**
 * Request-context plugin: resolves the actor / tenant from Elysia's context
 * (whatever your auth plugin derived) and opens an audit context scope for
 * the handler, so every `audit.record()` inside it is attributed. Register
 * it after the plugin that derives your user.
 *
 * ```ts
 * app.use(auth).use(auditContext({ actor: ({ user }) => user, tenant: ({ user }) => user?.orgId }));
 * ```
 */
export function auditContext(options: AuditContextOptions<ElysiaAuditContextCtx> = {}) {
  return new Elysia()
    .derive("global", async (ctx) => {
      const server = (ctx as { server?: BunServerLike | null }).server;
      const ip = server?.requestIP?.(ctx.request)?.address ?? null;
      const auditScope: AuditScope = await resolveAuditScope(
        ctx.request,
        ctx as ElysiaAuditContextCtx,
        options,
        ip,
      );
      return { auditScope };
    })
    .onBeforeHandle("global", ({ auditScope }) => {
      // Synchronous on purpose: `enterWith` here carries into the handler.
      setAuditContext(auditScope);
    });
}
