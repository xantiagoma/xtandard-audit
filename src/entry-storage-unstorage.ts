/**
 * unstorage storage: `createUnstorageStorage()` wraps an unstorage instance,
 * so any of its 20+ drivers can back the store. KV only (generic KV event log,
 * single writer per tenant).
 *
 * Import from `@xtandard/audit/storage/unstorage`.
 *
 * @module storage/unstorage
 */

export * from "./storage/unstorage.ts";
