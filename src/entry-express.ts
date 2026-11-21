/**
 * Express adapter: `auditPanel()` bridges Node's `req`/`res` to the
 * web-standard panel handler (mount it before any body parser), and
 * `auditContext()` opens a request-context scope around `next()`.
 *
 * Import from `@xtandard/audit/express`.
 *
 * @module express
 */

export * from "./adapters/express.ts";
