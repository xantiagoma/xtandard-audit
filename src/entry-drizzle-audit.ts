/**
 * The `drizzle-audit` bridge: `createDrizzleAuditStorage()` turns drizzle-audit's
 * row-level change entries into tenant-scoped, hash-chained audit events, and
 * `importDrizzleAuditEntries()` migrates historical rows. Typed structurally —
 * no dependency on `drizzle-audit`.
 *
 * Import from `@xtandard/audit/drizzle-audit`.
 *
 * @module drizzle-audit
 */

export * from "./bridges/drizzle-audit.ts";
