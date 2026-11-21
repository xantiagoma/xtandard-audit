/**
 * MongoDB storage adapter built on the [`mongodb`](https://github.com/mongodb/node-mongodb-native)
 * driver, an optional peer dependency. You can either pass a pre-constructed
 * (optionally pre-connected) `MongoClient`, or a connection `url` to create and
 * connect a client lazily on first use.
 *
 * Two collections:
 *
 * - **KV** (`audit_kv` by default) — `{ _id: <key>, value: <any> }` documents
 *   for control data (catalog, chain heads, checkpoints, stream cursors), the
 *   `@xtandard/kit/storage/mongodb` driver: values are stored as BSON with
 *   sorted fields, `getKeys(prefix)` matches `_id` against an anchored regular
 *   expression plus an exact `startsWith`, and `compareAndSwap` is one
 *   `updateOne`. The events collection shares its connection
 *   (`mongoConnection`).
 * - **Events** (`audit_events` by default) — the native
 *   {@link EventLogStorage} capability (ADR 0005): one document per event (the
 *   event itself plus a denormalized, lower-cased `search` field), with a
 *   unique index on `(tenant, seq)` and `(tenant, id)`, and indexes on
 *   `(tenant, occurredAt, id)`, `(tenant, actor.id, …)`, `(tenant, action, …)`
 *   and a multikey index on `targets`. Indexes are created on first use.
 *   Queries compile to Mongo filters (`$in`/anchored regex for actions,
 *   `$elemMatch` for targets, an escaped regex over `search`) with keyset
 *   pagination via `$or` on `(occurredAt, id)`.
 *
 * ## Appends without transactions
 *
 * `appendEvents` checks the tenant's current max `seq` equals `expectedSeq`,
 * then `insertMany`s the batch (ordered). A concurrent writer that slips in
 * between trips the unique `(tenant, seq)` index: the adapter deletes whatever
 * this call inserted (unless another writer already chained onto it) and throws
 * {@link ChainConflictError}, so the core re-reads the head and re-chains. No
 * replica set or transactions are required. Event metadata may contain `$`- or
 * `.`-prefixed keys (erasure writes `{ $erased: true }`), which needs MongoDB
 * 5.0+.
 *
 * ## Why no `watch`
 *
 * MongoDB change streams (the natural way to back `WatchableAuditStorage`)
 * require a replica set or sharded cluster — they are unavailable on a standalone
 * `mongod`. To keep this adapter usable against any deployment, `watch` is
 * intentionally **not** implemented; the core feature-detects its absence and
 * falls back to polling. Wrap it with `withWatch` to supply your own signal.
 *
 * @module
 */

import type { CompareAndSwapKvStorage } from "@xtandard/kit/storage";
import { escapeRegex } from "@xtandard/kit/storage";
import type * as kit from "@xtandard/kit/storage/mongodb";
import {
  mongoConnection,
  mongoKvStorage,
  type KvDocument,
} from "@xtandard/kit/storage/mongodb/internals";
import type { Collection, Filter } from "mongodb";
import { searchText, type NormalizedQuery } from "../query.ts";
import type { AuditEvent } from "../schema.ts";
import { ChainConflictError } from "./contract.ts";
import type { EventLogStorage } from "./contract.ts";

/**
 * Options for {@link createMongoStorage}: a `client` or a `url`, the database
 * (`dbName`, default `"xtandard_audit"`) and the KV collection
 * (`collectionName`, default `"audit_kv"`).
 */
export interface MongoStorageOptions extends kit.MongoStorageOptions {
  /** Events collection name. Defaults to `"audit_events"`. */
  eventsCollectionName?: string;
}

/**
 * An {@link EventLogStorage} backed by MongoDB, plus a `close()` method that
 * disconnects the client — but only the one this adapter created. A client you
 * passed in is left for you to manage.
 *
 * Note: `watch` is deliberately absent (see the module docs).
 */
export interface MongoAuditStorage extends EventLogStorage, CompareAndSwapKvStorage {
  /** Disconnect the underlying client if this adapter created it. No-op otherwise. */
  close(): Promise<void>;
}

/** An event document: the event plus its denormalized search text. */
type EventDoc = AuditEvent & { search: string };

/** Read projection: hand back exactly the stored event. */
const EVENT_PROJECTION = { _id: 0, search: 0 } as const;

/** Anchored "starts with" regex for a literal prefix. */
const startsWith = (prefix: string): RegExp => new RegExp(`^${escapeRegex(prefix)}`);

const toDoc = (event: AuditEvent): EventDoc => ({ ...event, search: searchText(event) });

/** Is this a duplicate-key (E11000) error, top-level or inside a bulk write? */
function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: number; writeErrors?: Array<{ code?: number }> } | null;
  if (e?.code === 11000) return true;
  return Array.isArray(e?.writeErrors) && e.writeErrors.some((w) => w.code === 11000);
}

/**
 * Compile a {@link NormalizedQuery} to a Mongo filter that agrees exactly with
 * `matchesQuery` (plus the keyset position when the query has one).
 */
export function mongoEventFilter(q: NormalizedQuery): Filter<EventDoc> {
  const and: Filter<EventDoc>[] = [];
  if (q.tenant !== undefined) and.push({ tenant: q.tenant });

  // Actions: (no include list) OR exact OR family prefix; then excludes.
  if ((q.actions.length > 0 || q.actionPrefixes.length > 0) && !q.actionPrefixes.includes("")) {
    const include: Filter<EventDoc>[] = [];
    if (q.actions.length > 0) include.push({ action: { $in: q.actions } });
    for (const p of q.actionPrefixes) include.push({ action: { $regex: startsWith(p) } });
    and.push(include.length === 1 ? include[0]! : { $or: include });
  }
  if (q.excludeActions.length > 0) and.push({ action: { $nin: q.excludeActions } });
  for (const p of q.excludeActionPrefixes) and.push({ action: { $not: startsWith(p) } });

  if (q.actorId !== undefined) and.push({ "actor.id": q.actorId });
  if (q.actorType !== undefined) {
    // A missing actor type means "user".
    and.push({
      "actor.type": q.actorType === "user" ? { $in: ["user", null] } : q.actorType,
    } as Filter<EventDoc>);
  }
  if (q.targetType !== undefined || q.targetId !== undefined) {
    and.push({
      targets: {
        $elemMatch: {
          ...(q.targetType !== undefined ? { type: q.targetType } : {}),
          ...(q.targetId !== undefined ? { id: q.targetId } : {}),
        },
      },
    } as Filter<EventDoc>);
  }
  if (q.outcome !== undefined) and.push({ outcome: q.outcome });
  if (q.from !== undefined || q.to !== undefined) {
    and.push({
      occurredAt: {
        ...(q.from !== undefined ? { $gte: q.from } : {}),
        ...(q.to !== undefined ? { $lt: q.to } : {}),
      },
    });
  }
  if (q.search !== undefined) and.push({ search: { $regex: new RegExp(escapeRegex(q.search)) } });

  if (q.after) {
    const op = q.order === "desc" ? "$lt" : "$gt";
    and.push({
      $or: [
        { occurredAt: { [op]: q.after.occurredAt } },
        { occurredAt: q.after.occurredAt, id: { [op]: q.after.id } },
      ],
    } as Filter<EventDoc>);
  }
  return and.length === 0 ? {} : and.length === 1 ? and[0]! : { $and: and };
}

/**
 * Create a MongoDB-backed {@link MongoAuditStorage}. Connection is lazy: the
 * client is created/connected on the first storage operation and reused
 * thereafter, guarded by a single connection promise so concurrent calls connect
 * once. Event indexes are created on the first event operation.
 *
 * @example
 * ```ts
 * import { createMongoStorage } from "@xtandard/audit/storage/mongodb";
 *
 * const storage = createMongoStorage({
 *   url: process.env.MONGODB_URL ?? "mongodb://localhost:27017",
 *   dbName: "myapp",
 * });
 *
 * // Disconnect when the process exits:
 * // process.on("SIGTERM", () => storage.close());
 * ```
 */
export function createMongoStorage(options: MongoStorageOptions): MongoAuditStorage {
  const {
    dbName = "xtandard_audit",
    collectionName = "audit_kv",
    eventsCollectionName = "audit_events",
  } = options;
  const connection = mongoConnection(
    { ...options, dbName },
    options.subpath ?? "@xtandard/audit/storage/mongodb",
  );
  let indexing: Promise<Collection<EventDoc>> | undefined;

  /** The events collection, with its indexes ensured once. */
  async function getEvents(): Promise<Collection<EventDoc>> {
    indexing ??= (async () => {
      const events = await connection.collection<EventDoc>(eventsCollectionName);
      await events.createIndexes([
        { key: { tenant: 1, seq: 1 }, name: "tenant_seq", unique: true },
        { key: { tenant: 1, id: 1 }, name: "tenant_id", unique: true },
        { key: { tenant: 1, occurredAt: 1, id: 1 }, name: "tenant_time" },
        { key: { tenant: 1, "actor.id": 1, occurredAt: 1, id: 1 }, name: "tenant_actor" },
        { key: { tenant: 1, action: 1, occurredAt: 1, id: 1 }, name: "tenant_action" },
        { key: { tenant: 1, "targets.type": 1, "targets.id": 1 }, name: "tenant_targets" },
      ]);
      return events;
    })();
    try {
      return await indexing;
    } catch (error) {
      indexing = undefined;
      throw error;
    }
  }

  return {
    ...mongoKvStorage(() => connection.collection<KvDocument>(collectionName)),

    async appendEvents(tenant, batch, { expectedSeq }): Promise<void> {
      if (batch.length === 0) return;
      batch.forEach((e, i) => {
        if (e.tenant !== tenant || e.seq !== expectedSeq + i + 1) {
          throw new ChainConflictError(tenant, expectedSeq);
        }
      });
      const events = await getEvents();
      const last = await events.findOne(
        { tenant },
        { sort: { seq: -1 }, projection: { _id: 0, seq: 1 } },
      );
      // An empty tenant accepts any expectedSeq (the core never prunes the head
      // event, so this only happens for a brand-new tenant or a manual wipe).
      if (last && last.seq !== expectedSeq) throw new ChainConflictError(tenant, expectedSeq);
      try {
        await events.insertMany(batch.map(toDoc), { ordered: true, ignoreUndefined: true });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Lost a race (or the ids exist): undo whatever this call inserted —
        // matched by exact (id, seq, hash) — unless another writer already chained
        // onto it, in which case removing it would break their chain.
        const ids = batch.map((e) => e.id);
        const hashes = batch.map((e) => e.integrity.hash);
        const builtOn = await events.findOne(
          { tenant, id: { $nin: ids }, "integrity.prevHash": { $in: hashes } },
          { projection: { _id: 1 } },
        );
        if (!builtOn) {
          await events.deleteMany({
            tenant,
            $or: batch.map((e) => ({ id: e.id, seq: e.seq, "integrity.hash": e.integrity.hash })),
          });
        }
        throw new ChainConflictError(tenant, expectedSeq);
      }
    },

    async getEvent(tenant, id): Promise<AuditEvent | null> {
      const events = await getEvents();
      return events.findOne<AuditEvent>({ tenant, id }, { projection: EVENT_PROJECTION });
    },

    async lastEvent(tenant): Promise<AuditEvent | null> {
      const events = await getEvents();
      return events.findOne<AuditEvent>(
        { tenant },
        { sort: { seq: -1 }, projection: EVENT_PROJECTION },
      );
    },

    async eventsBySeq(tenant, { afterSeq, limit }): Promise<AuditEvent[]> {
      const events = await getEvents();
      return events
        .find<AuditEvent>({ tenant, seq: { $gt: afterSeq } }, { projection: EVENT_PROJECTION })
        .sort({ seq: 1 })
        .limit(limit)
        .toArray();
    },

    async queryEvents(q: NormalizedQuery) {
      const events = await getEvents();
      const dir = q.order === "desc" ? -1 : 1;
      const rows = await events
        .find<AuditEvent>(mongoEventFilter(q), { projection: EVENT_PROJECTION })
        .sort({ occurredAt: dir, id: dir })
        .limit(q.limit + 1)
        .toArray();
      return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
    },

    async replaceEvent(event): Promise<void> {
      const events = await getEvents();
      await events.replaceOne(
        { tenant: event.tenant, id: event.id, seq: event.seq },
        toDoc(event),
        { ignoreUndefined: true },
      );
    },

    async deleteEventsThrough(tenant, throughSeq): Promise<number> {
      const events = await getEvents();
      const result = await events.deleteMany({ tenant, seq: { $lte: throughSeq } });
      return result.deletedCount;
    },

    async countEvents(tenant): Promise<number> {
      const events = await getEvents();
      return events.countDocuments(tenant !== undefined ? { tenant } : {});
    },

    async listEventTenants(): Promise<string[]> {
      const events = await getEvents();
      return ((await events.distinct("tenant")) as string[]).sort();
    },

    close: connection.close,
  } satisfies MongoAuditStorage;
}
