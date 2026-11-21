/**
 * Hono adapter: `auditPanel()` returns a Hono sub-app serving the panel,
 * to compose with `app.route(path, panel)`, and `auditContext()`, the
 * request-context middleware.
 *
 * Import from `@xtandard/audit/hono`.
 *
 * @module hono
 */

export * from "./adapters/hono.ts";
