/**
 * Postgres storage: `createPostgresStorage()` keeps a `jsonb` key/value table
 * plus the native event-log tables (indexed queries, atomic appends), all
 * created on first use. Works with `pg` or PGlite.
 *
 * Import from `@xtandard/audit/storage/postgres`.
 *
 * @module storage/postgres
 */

export * from "./storage/postgres.ts";
