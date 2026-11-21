/**
 * Redis storage adapters built on the [`redis`](https://github.com/redis/node-redis)
 * package (node-redis v4/v5), an optional peer dependency. You can either pass a
 * pre-connected `client` or a `url` to connect lazily on first use. An optional
 * `prefix` is prepended (with a `:` separator) to every key so multiple
 * deployments can share a Redis instance without collisions; the prefix is
 * stripped from keys returned by {@link RedisAuditStorage.getKeys}.
 *
 * Two variants over the same plumbing, differing only in the value encoding:
 *
 * - {@link createRedisStorage} — values are plain **strings** containing JSON
 *   (`SET`/`GET`). Works on any Redis; the default choice.
 * - {@link createRedisJSONStorage} — values are native **RedisJSON** documents
 *   (`JSON.SET`/`JSON.GET`), so the stored data is queryable with JSONPath and
 *   indexable with RediSearch. Requires the JSON module (Redis 8 / Redis Stack).
 *   Do NOT point both variants at the same keys — the types are incompatible
 *   (`WRONGTYPE`).
 *
 * The driver is `@xtandard/kit/storage/redis`. `getKeys` uses a non-blocking,
 * de-duplicated `SCAN` cursor (never the blocking `KEYS` command), with the
 * prefix glob-escaped. `watch` is implemented with Redis keyspace notifications; it
 * requires the server to be configured with `notify-keyspace-events` covering
 * generic + string + expiry events (e.g. `KEA` — whose `A` class also covers the
 * module events that RedisJSON writes emit, e.g. `json.set`).
 *
 * ## Events and multi-writer safety (`compareAndSwap`)
 *
 * Events go through the core's generic KV event log (ADR 0005): one key per
 * event plus secondary index keys, queried by scanning the most selective
 * index. Both variants implement `compareAndSwap` with a small Lua script that
 * runs atomically on the server: values are written as canonical JSON, the
 * script compares the stored text with the expected value's canonical JSON, and
 * on a miss the driver compares structurally in JS and swaps on the exact
 * stored text (so values written by earlier releases swap too, and `{}` never
 * equals `[]`). The core CAS-es each
 * tenant's chain head before writing events, so several processes can append to
 * the same tenant safely — a loser re-reads the head and re-chains.
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/redis";

/**
 * Options for {@link createRedisStorage}: a `url` or a pre-connected `client`,
 * an optional key `prefix` (joined with `:`), an `onError` observer for client
 * `error` events, and an `onWrite` hook.
 */
export type RedisStorageOptions = kit.RedisStorageOptions;

/**
 * A watchable, compare-and-swap capable storage backed by Redis, plus a
 * `close()` method that disconnects the client — but only the one this adapter
 * created. A client you passed in is left for you to manage.
 */
export type RedisAuditStorage = kit.RedisKvStorage;

/**
 * Create a Redis-backed {@link RedisAuditStorage}. Connection is lazy: the
 * client is created/connected on the first storage operation and reused
 * thereafter, guarded by a single connection promise so concurrent calls connect
 * once.
 *
 * @example
 * ```ts
 * import { createRedisStorage } from "@xtandard/audit/storage/redis";
 *
 * const storage = createRedisStorage({
 *   url: process.env.REDIS_URL ?? "redis://localhost:6379",
 *   prefix: "myapp:audit",
 *   onError: (err) => console.error("[audit/redis]", err),
 * });
 *
 * // Disconnect when the process exits:
 * // process.on("SIGTERM", () => storage.close());
 * ```
 */
export function createRedisStorage(options: RedisStorageOptions): RedisAuditStorage {
  return kit.createRedisStorage({ subpath: "@xtandard/audit/storage/redis", ...options });
}

/**
 * Create a Redis-backed {@link RedisAuditStorage} that stores values as native
 * **RedisJSON** documents (`JSON.SET`/`JSON.GET`) instead of strings — making
 * the stored records queryable with JSONPath (`JSON.GET key $.action`) and
 * indexable with RediSearch, while the audit system behaves identically.
 *
 * Requires the JSON module on the server (built into Redis 8; Redis Stack; or
 * `redisjson` loaded). Same options and semantics as {@link createRedisStorage},
 * including lazy connection, `SCAN`-based `getKeys`, keyspace-notification
 * `watch`, and the Lua `compareAndSwap`. **Do not point it at keys written by
 * `createRedisStorage`** (or vice versa) — the underlying types differ and
 * Redis answers `WRONGTYPE`.
 *
 * @example
 * ```ts
 * import { createRedisJSONStorage } from "@xtandard/audit/storage/redis";
 *
 * const storage = createRedisJSONStorage({
 *   url: process.env.REDIS_URL ?? "redis://localhost:6379",
 *   prefix: "myapp:audit",
 * });
 * // Then, in redis-cli: JSON.GET myapp:audit:aud/t/acme/events/000000000001 $.action
 * ```
 */
export function createRedisJSONStorage(options: RedisStorageOptions): RedisAuditStorage {
  return kit.createRedisJSONStorage({ subpath: "@xtandard/audit/storage/redis", ...options });
}
