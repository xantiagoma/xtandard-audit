/**
 * Cloudflare Workers KV storage: `createCloudflareKvStorage()` wraps a
 * `KVNamespace` binding. No npm peer dependency; KV only (generic KV event
 * log, single writer per tenant).
 *
 * Import from `@xtandard/audit/storage/cloudflare-kv`.
 *
 * @module storage/cloudflare-kv
 */

export * from "./storage/cloudflare-kv.ts";
