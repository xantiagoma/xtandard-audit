import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MongoClient } from "mongodb";
import { createAuditCore } from "../src/core.ts";
import { GENESIS_HASH, sealChain } from "../src/integrity.ts";
import { applyQuery, normalizeQuery } from "../src/query.ts";
import type { AuditEvent, AuditQuery } from "../src/schema.ts";
import { ChainConflictError, hasEventLog, isWatchable } from "../src/storage/contract.ts";
import { createMongoStorage, type MongoAuditStorage } from "../src/storage/mongodb.ts";
import { runStorageContractTests, seedEvents } from "./storage-contract.ts";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27117";

// Detect a reachable MongoDB up front (short timeout) so CI without a server
// simply skips the live suite instead of hanging on connection attempts.
let available = false;
{
  const probe = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  try {
    await probe.connect();
    await probe.db("admin").command({ ping: 1 });
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.close().catch(() => {});
  }
}

// A unique database per run keeps concurrent/repeated runs isolated; it is
// dropped in afterAll.
const dbName = `audit_test_${Date.now()}`;

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

describe.skipIf(!available)("createMongoStorage (live)", () => {
  // Fresh collections per contract test, so the shared suite starts empty.
  let counter = 0;
  const makers: MongoAuditStorage[] = [];
  const collections = new WeakMap<object, string>();
  const make = () => {
    const n = counter++;
    const storage = createMongoStorage({
      url: MONGO_URL,
      dbName,
      collectionName: `kv_${n}`,
      eventsCollectionName: `events_${n}`,
    });
    makers.push(storage);
    collections.set(storage, `kv_${n}`);
    return storage;
  };

  runStorageContractTests("mongodb", make, {
    t: { describe, test, expect },
    capabilities: { compareAndSwap: true, watch: false },
    expectNativeEventLog: true,
    timeout: 20_000,
    seedLegacy: async (storage, key, raw) => {
      // A document written by an earlier release: fields in insertion order.
      const client = new MongoClient(MONGO_URL);
      try {
        await client.connect();
        await client
          .db(dbName)
          .collection<{ _id: string; value: unknown }>(collections.get(storage)!)
          .insertOne({ _id: key, value: JSON.parse(raw) });
      } finally {
        await client.close();
      }
    },
  });

  describe("mongodb specifics", () => {
    let storage: MongoAuditStorage;

    beforeAll(() => {
      storage = make();
    });

    test("creates the event indexes", async () => {
      await storage.countEvents();
      const client = new MongoClient(MONGO_URL);
      try {
        await client.connect();
        const names = (
          await client
            .db(dbName)
            .collection(`events_${counter - 1}`)
            .indexes()
        )
          .map((i) => i.name)
          .sort();
        expect(names).toEqual(
          [
            "_id_",
            "tenant_action",
            "tenant_actor",
            "tenant_id",
            "tenant_seq",
            "tenant_targets",
            "tenant_time",
          ].sort(),
        );
      } finally {
        await client.close();
      }
    });
  });

  test(
    "query results agree exactly with matchesQuery/applyQuery",
    { timeout: 30_000 },
    async () => {
      const storage = make();
      const { audit, recorded } = await seedEvents(storage);
      // Awkward content: regex metacharacters, a missing actor type, case.
      recorded.push(
        await audit.record({
          tenant: "acme",
          action: "invoice.paid",
          actor: { id: "u.(1)+", type: "user", name: "Ünïcode Ådmin" },
          targets: [{ type: "invoice", id: "inv_[2]" }],
          description: "Paid $42.00 (card *1234)",
          metadata: { note: "a.b|c" },
          occurredAt: at(5),
        }),
      );
      const queries: AuditQuery[] = [
        {},
        { tenant: "acme" },
        { tenant: "acme", order: "asc", limit: 3 },
        { actions: ["user.*"] },
        { actions: ["*"], excludeActions: ["invoice.*", "user.logout"] },
        { excludeActions: ["*"] },
        { tenant: "acme", actorType: "user" },
        { tenant: "acme", actorType: "api_key" },
        { tenant: "acme", targetType: "invoice" },
        { tenant: "acme", targetId: "inv_[2]" },
        { tenant: "acme", targetType: "user", targetId: "inv_1" },
        { tenant: "acme", outcome: "success" },
        { from: at(2), to: at(4) },
        { tenant: "acme", search: "$42.00 (card" },
        { tenant: "acme", search: "ÜNÏCODE" },
        { tenant: "acme", search: "a.b|c" },
        { tenant: "acme", search: "u.(1)+" },
        { tenant: "acme", search: "." },
      ];
      const all: AuditEvent[] = [];
      for (const t of ["acme", "globex"]) {
        all.push(...(await storage.eventsBySeq(t, { afterSeq: 0, limit: 100 })));
      }
      for (const query of queries) {
        const nq = normalizeQuery(query);
        const expected = applyQuery(all, nq);
        const actual = await storage.queryEvents(nq);
        expect({ query, ids: actual.items.map((e) => e.id), more: actual.hasMore }).toEqual({
          query,
          ids: expected.items.map((e) => e.id),
          more: expected.hasMore,
        });
        // Keyset continuation agrees too.
        const last = expected.items[expected.items.length - 1];
        if (last) {
          const next = { ...nq, after: { occurredAt: last.occurredAt, id: last.id } };
          expect((await storage.queryEvents(next)).items.map((e) => e.id)).toEqual(
            applyQuery(all, next).items.map((e) => e.id),
          );
        }
      }
    },
  );

  async function rawInsert(collection: string, docs: object[]) {
    const client = new MongoClient(MONGO_URL);
    try {
      await client.connect();
      await client.db(dbName).collection(collection).insertMany(docs);
    } finally {
      await client.close();
    }
  }

  async function chainOf3() {
    const base = {
      tenant: "r",
      action: "x.y",
      occurredAt: at(1),
      recordedAt: at(1),
      actor: { id: "1" },
      targets: [],
      context: {},
      metadata: {},
    };
    return sealChain(
      [1, 2, 3].map((seq) => ({ ...base, id: `evt_01JD000000000000000000000${seq}`, seq })),
      GENESIS_HASH,
    );
  }

  test("a duplicate key mid-batch rolls back this call's partial insert", async () => {
    const storage = make();
    const [e1, e2, e3] = await chainOf3();
    await storage.appendEvents("r", [e1!], { expectedSeq: 0 });
    // A foreign document already owns e3's id (below the head, so the max-seq
    // precheck passes): e2 inserts, e3 trips the unique (tenant, id) index.
    await rawInsert(`events_${counter - 1}`, [{ ...e3!, seq: 0, search: "" }]);
    await expect(storage.appendEvents("r", [e2!, e3!], { expectedSeq: 1 })).rejects.toBeInstanceOf(
      ChainConflictError,
    );
    expect((await storage.eventsBySeq("r", { afterSeq: -1, limit: 10 })).map((e) => e.seq)).toEqual(
      [0, 1],
    );
  });

  test("a partial insert another writer chained onto is kept", async () => {
    const storage = make();
    const [e1, e2, e3] = await chainOf3();
    await storage.appendEvents("r", [e1!], { expectedSeq: 0 });
    await rawInsert(`events_${counter - 1}`, [
      { ...e3!, seq: 0, search: "" },
      // Someone else's event whose prevHash is e2's hash.
      { ...e3!, id: "evt_01JD0000000000000000000099", seq: -1, search: "" },
    ]);
    await expect(storage.appendEvents("r", [e2!, e3!], { expectedSeq: 1 })).rejects.toBeInstanceOf(
      ChainConflictError,
    );
    expect((await storage.eventsBySeq("r", { afterSeq: -2, limit: 10 })).map((e) => e.seq)).toEqual(
      [-1, 0, 1, 2],
    );
  });

  test(
    "multiple writers append to one tenant without forking the chain",
    { timeout: 20_000 },
    async () => {
      // Fresh collections per attempt, so a retried run starts empty.
      const n = counter++;
      const shared = {
        url: MONGO_URL,
        dbName,
        collectionName: `kv_mw_${n}`,
        eventsCollectionName: `ev_mw_${n}`,
      };
      const a = createMongoStorage(shared);
      const b = createMongoStorage(shared);
      makers.push(a, b);
      const coreA = createAuditCore({ storage: a, selfAudit: false });
      const coreB = createAuditCore({ storage: b, selfAudit: false });
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? coreA : coreB).record({
            tenant: "shared",
            action: "x.tick",
            actor: { id: `${i}` },
          }),
        ),
      );
      const report = await coreA.verify("shared");
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(12);
    },
  );

  afterAll(async () => {
    // Drop the throwaway database, then close every client this suite opened so
    // the vitest process can exit cleanly.
    const cleanup = new MongoClient(MONGO_URL);
    try {
      await cleanup.connect();
      await cleanup.db(dbName).dropDatabase();
    } finally {
      await cleanup.close();
    }
    for (const s of makers) await s.close();
  }, 60_000);
});

/**
 * Shape checks that need no live server: a created adapter exposes the full
 * {@link MongoAuditStorage} surface (KV + native event log + `close`) and is
 * not watchable.
 */
describe("createMongoStorage shape", () => {
  test("exposes the AuditStorage + event log + close surface without connecting", () => {
    const storage = createMongoStorage({ url: "mongodb://localhost:27017" });
    expect(typeof storage.getItem).toBe("function");
    expect(typeof storage.setItem).toBe("function");
    expect(typeof storage.removeItem).toBe("function");
    expect(typeof storage.getKeys).toBe("function");
    expect(typeof storage.close).toBe("function");
    expect(hasEventLog(storage)).toBe(true);
    expect(isWatchable(storage)).toBe(false);
  });

  test("close() before any connection is a safe no-op", async () => {
    const storage = createMongoStorage({ url: "mongodb://localhost:27017" });
    await expect(storage.close()).resolves.toBeUndefined();
  });

  test("throws a clear error when neither client nor url is supplied", async () => {
    const storage = createMongoStorage({});
    await expect(storage.getItem("aud/t/acme/head")).rejects.toThrow(
      /requires either a `client` or a `url`/,
    );
  });

  test("a connection failure is not cached: a later call retries", async () => {
    // Point at an unroutable port with a short server-selection timeout so this
    // fails fast. The first call rejects; the second must attempt to connect
    // again (the `connecting` promise is cleared on failure).
    const storage = createMongoStorage({
      url: "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200",
    });
    await expect(storage.getItem("aud/t/acme/head")).rejects.toBeTruthy();
    await expect(storage.getItem("aud/t/acme/head")).rejects.toBeTruthy();
    await storage.close();
  });

  test("a pre-connected, borrowed client is not closed by close()", async () => {
    let closed = false;
    const fakeCollection = {
      findOne: async () => null,
      updateOne: async () => ({}),
      deleteOne: async () => ({}),
      find: () => ({ project: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
    };
    const fakeClient = {
      async connect() {},
      db: () => ({ collection: () => fakeCollection }),
      async close() {
        closed = true;
      },
    };
    const storage = createMongoStorage({ client: fakeClient as never });
    expect(await storage.getItem("aud/t/acme/head")).toBeNull();
    await storage.close();
    // close() is a no-op for borrowed clients.
    expect(closed).toBe(false);
  });

  test("an 'already connected' connect() error is swallowed", async () => {
    const fakeCollection = { findOne: async () => null };
    const fakeClient = {
      async connect() {
        throw new Error("MongoClient is already connected");
      },
      db: () => ({ collection: () => fakeCollection }),
      async close() {},
    };
    const storage = createMongoStorage({ client: fakeClient as never });
    expect(await storage.getItem("aud/t/acme/head")).toBeNull();
  });

  test("a genuine connect() error propagates", async () => {
    const fakeClient = {
      async connect() {
        throw new Error("authentication failed");
      },
      db: () => ({ collection: () => ({}) }),
      async close() {},
    };
    const storage = createMongoStorage({ client: fakeClient as never });
    await expect(storage.getItem("aud/t/acme/head")).rejects.toThrow(/authentication failed/);
  });

  test("an index-creation failure is not cached", async () => {
    let attempts = 0;
    const events = {
      createIndexes: async () => {
        attempts++;
        throw new Error("not authorized");
      },
    };
    const fakeClient = {
      async connect() {},
      db: () => ({ collection: () => events }),
      async close() {},
    };
    const storage = createMongoStorage({ client: fakeClient as never });
    await expect(storage.countEvents()).rejects.toThrow(/not authorized/);
    await expect(storage.countEvents()).rejects.toThrow(/not authorized/);
    expect(attempts).toBe(2);
  });

  test("appendEvents rejects a batch that does not continue expectedSeq", async () => {
    const storage = createMongoStorage({ url: "mongodb://localhost:27017" });
    const event = { tenant: "t", seq: 3 } as AuditEvent;
    await expect(storage.appendEvents("t", [event], { expectedSeq: 0 })).rejects.toBeInstanceOf(
      ChainConflictError,
    );
    await expect(storage.appendEvents("t", [], { expectedSeq: 0 })).resolves.toBeUndefined();
  });
});
