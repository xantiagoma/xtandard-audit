/**
 * Drizzle storage: `createDrizzleStorage()` reads and writes tables you own
 * (built with the `drizzle/*` factories) through the Drizzle database you
 * pass — the KV table, plus the events tables for the native event log. No
 * DDL, no connection of its own; Postgres, MySQL or SQLite.
 *
 * Import from `@xtandard/audit/storage/drizzle`.
 *
 * @module storage/drizzle
 */

export * from "./storage/drizzle.ts";
