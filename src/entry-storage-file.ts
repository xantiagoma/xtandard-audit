/**
 * File-system storage: `createFileStorage()` persists each key as a JSON file
 * under a base directory. Zero dependencies; Bun and Node. KV only — events use
 * the core's generic KV event log, single writer per tenant.
 *
 * Import from `@xtandard/audit/storage/file`.
 *
 * @module storage/file
 */

export * from "./storage/file.ts";
