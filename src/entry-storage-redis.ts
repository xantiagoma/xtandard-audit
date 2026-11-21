/**
 * Redis storage: `createRedisStorage()` (JSON strings) and
 * `createRedisJSONStorage()` (RedisJSON documents) over node-redis, with a Lua
 * compare-and-swap (safe multi-writer appends) and keyspace-notification watch.
 * KV only — events use the core's generic KV event log.
 *
 * Import from `@xtandard/audit/storage/redis`.
 *
 * @module storage/redis
 */

export * from "./storage/redis.ts";
