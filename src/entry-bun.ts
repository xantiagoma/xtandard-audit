/**
 * Bun adapter: `auditPanel()` returns the web-standard panel handler to hand
 * to `Bun.serve({ fetch })`, with the core and the stream runner attached;
 * `withAuditContext()` wraps a fetch handler so every request runs in an
 * audit context scope (actor, tenant, IP, user agent, request id).
 *
 * Import from `@xtandard/audit/bun`.
 *
 * @module bun
 */

export * from "./adapters/bun.ts";
