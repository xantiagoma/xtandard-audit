/**
 * Cloudflare Workers KV storage adapter. It wraps a `KVNamespace` **binding** —
 * the object Workers exposes on `env.MY_KV` — so it works in production Workers,
 * in local dev via `wrangler dev` / [Miniflare](https://miniflare.dev), and in
 * tests against any object that satisfies the small {@link KVNamespaceLike}
 * surface. There is **no npm peer dependency**: the binding is provided by the
 * runtime, so this adapter only needs the structural type.
 *
 * KV is eventually consistent, has a ~25 MB per-value limit and paginated
 * `list` (the adapter follows the cursor until the listing is complete). An
 * optional `prefix` namespaces every key (joined with `:`) and is stripped from
 * {@link CloudflareKvAuditStorage.getKeys} results, so several deployments can
 * share one namespace. The driver is `@xtandard/kit/storage/cloudflare-kv`.
 *
 * KV only: events go through the core's generic KV event log (ADR 0005), and
 * Workers KV has no compare-and-swap, so the core assumes a **single writer
 * per tenant**. Eventual consistency also means a read in another location may
 * briefly miss a fresh event. Fine for low-volume tenants with retention; for
 * multi-writer or high-volume logs prefer a native driver (D1/libSQL, Postgres).
 * Workers have no long-lived process: drive stream runners and retention from
 * a [cron trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
 * (`scheduled` handler).
 *
 * ```ts
 * import { createCloudflareKvStorage } from "@xtandard/audit/storage/cloudflare-kv";
 *
 * export default {
 *   async fetch(req: Request, env: { AUDIT: KVNamespace }) {
 *     const storage = createCloudflareKvStorage({ namespace: env.AUDIT, prefix: "prod" });
 *     // …build the audit core over `storage`…
 *   },
 * };
 * ```
 *
 * @module
 */

export {
  createCloudflareKvStorage,
  type CloudflareKvStorage as CloudflareKvAuditStorage,
  type CloudflareKvStorageOptions,
  type KVNamespaceLike,
} from "@xtandard/kit/storage/cloudflare-kv";
