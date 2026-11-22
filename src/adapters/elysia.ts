/**
 * Elysia adapter. Two ways to mount:
 *
 * 1. {@link auditPanel} — a web-standard handler for `Elysia.mount(path, handler)`.
 *    Simplest, but opaque to Eden (the typed client can't see the routes).
 *
 *    ```ts
 *    new Elysia().mount("/audit", auditPanel({ basePath: "/audit", storage }));
 *    ```
 *
 * 2. {@link auditElysia} — a typed Elysia plugin that *declares* the API
 *    routes, so **Eden treaty** infers them: `client.audit.api.tenants.get()`,
 *    etc. Each handler delegates to the same pipeline (auth/validation/logic
 *    reused); export streams pass through untouched.
 *
 *    ```ts
 *    import { treaty } from "@elysiajs/eden";
 *    const app = new Elysia().use(auditElysia({ prefix: "/audit", storage }));
 *    const client = treaty<typeof app>("localhost:3000");
 *    await client.audit.api.tenants.get();
 *    ```
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
 * Elysia 1.x only — for Elysia 2 import from `@xtandard/audit/elysia2`.
 */
export function auditElysia(options: AuditElysiaOptions) {
  const { prefix, pass } = createPass(options);

  const tenant = "/api/tenants/:tenant";
  const event = `${tenant}/events/:id`;

  return new Elysia({ prefix, name: "xtandard-audit", seed: prefix })
    .get("/config", pass)
    .get("/api/config", pass)
    .get("/api/openapi.json", pass)
    .get("/api/integrity/keys", pass)
    .get("/api/overview", pass)
    .get("/api/tenants", pass)
    .get(tenant, pass, { params: tenantParams })
    .get("/api/events", pass)
    .get(`${tenant}/events`, pass, { params: tenantParams })
    .post(`${tenant}/events`, pass, {
      params: tenantParams,
      body: t.Union([eventInput, t.Array(eventInput)]),
    })
    .get(event, pass, { params: eventParams })
    .post(`${event}/erase`, pass, {
      params: eventParams,
      body: t.Optional(
        t.Object({
          sections: t.Optional(t.Array(t.String())),
          reason: t.Optional(t.String()),
        }),
      ),
    })
    .get(`${tenant}/export`, pass, { params: tenantParams })
    .get(`${tenant}/verify`, pass, { params: tenantParams })
    .get(`${tenant}/checkpoints`, pass, { params: tenantParams })
    .post(`${tenant}/checkpoints`, pass, { params: tenantParams })
    .post(`${tenant}/prune`, pass, { params: tenantParams })
    .post("/api/prune", pass)
    .get("/api/actions", pass)
    .put("/api/actions/:name", pass, { params: nameParams, body: actionInput })
    .delete("/api/actions/:name", pass, { params: nameParams })
    .get("/api/streams", pass)
    .post("/api/streams/:name/retry", pass, { params: nameParams })
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
    .derive({ as: "global" }, async (ctx) => {
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
    .onBeforeHandle({ as: "global" }, ({ auditScope }) => {
      // Synchronous on purpose: `enterWith` here carries into the handler.
      setAuditContext(auditScope);
    });
}
