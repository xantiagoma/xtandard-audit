/**
 * MongoDB storage: `createMongoStorage()` over the `mongodb` driver — a KV
 * collection of `{ _id: key, value }` documents for control data plus a native,
 * indexed events collection (the `EventLogStorage` capability).
 *
 * Import from `@xtandard/audit/storage/mongodb`.
 *
 * @module storage/mongodb
 */

export * from "./storage/mongodb.ts";
