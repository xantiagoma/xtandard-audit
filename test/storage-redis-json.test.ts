import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createRedisJSONStorage,
  createRedisStorage,
  type RedisAuditStorage,
} from "../src/storage/redis.ts";
import { fakeRedisClient } from "./redis-fake.ts";
import { runStorageContractTests } from "./storage-contract.ts";

// The whole contract over the fake client's RedisJSON store.
runStorageContractTests(
  "redis JSON (fake client)",
  () => createRedisJSONStorage({ client: fakeRedisClient().client, prefix: "ns" }),
  { expectNativeEventLog: false },
);

describe("createRedisJSONStorage (fake client)", () => {
  test("stores values via JSON.SET at the root path, prefixed", async () => {
    const { client, docs } = fakeRedisClient();
    const storage = createRedisJSONStorage({ client, prefix: "app:audit" });
    const value = { action: "invoice.paid", nested: { tags: ["a"] } };
    await storage.setItem("aud/t/acme/events/000000000001", value);

    // Native JSON document (not a serialized string), under the namespaced key.
    expect(docs.get("app:audit:aud/t/acme/events/000000000001")).toEqual(value);
    expect(await storage.getItem("aud/t/acme/events/000000000001")).toEqual(value);
  });

  test("returns null for missing keys and after removeItem", async () => {
    const { client } = fakeRedisClient();
    const storage = createRedisJSONStorage({ client });
    expect(await storage.getItem("nope")).toBeNull();
    await storage.setItem("k", { n: 1 });
    await storage.removeItem("k");
    expect(await storage.getItem("k")).toBeNull();
  });

  test("getKeys scans with the namespace and strips it", async () => {
    const { client } = fakeRedisClient();
    const storage = createRedisJSONStorage({ client, prefix: "ns" });
    await storage.setItem("aud/t/t1/head", 1);
    await storage.setItem("aud/t/t2/head", 2);
    expect((await storage.getKeys("aud/t/t1/")).sort()).toEqual(["aud/t/t1/head"]);
  });

  test("falsy JSON values round-trip (false, 0)", async () => {
    const { client } = fakeRedisClient();
    const storage = createRedisJSONStorage({ client });
    await storage.setItem("f", false);
    await storage.setItem("z", 0);
    expect(await storage.getItem("f")).toBe(false);
    expect(await storage.getItem("z")).toBe(0);
  });

  test("compareAndSwap uses the JSON.GET/JSON.SET script", async () => {
    const { client, docs, evalCalls } = fakeRedisClient();
    const storage = createRedisJSONStorage({ client, prefix: "ns" });
    expect(await storage.compareAndSwap({ key: "aud/k", expected: null, next: { seq: 1 } })).toBe(
      true,
    );
    expect(docs.get("ns:aud/k")).toEqual({ seq: 1 });
    expect(evalCalls[0]!.script).toContain("redis.call('JSON.GET', KEYS[1])");
    expect(evalCalls[0]!.script).toContain("redis.call('JSON.SET', KEYS[1], '$', ARGV[3])");
    expect(
      await storage.compareAndSwap({ key: "aud/k", expected: { seq: 2 }, next: { seq: 3 } }),
    ).toBe(false);
  });

  test("a client without json commands throws an actionable error", async () => {
    const { client } = fakeRedisClient({ json: false });
    const storage = createRedisJSONStorage({ client });
    await expect(storage.setItem("k", 1)).rejects.toThrow(/RedisJSON module/);
  });
});

/**
 * Integration suite — runs only when `REDIS_STACK_URL` points at a server with
 * the JSON module (Redis 8 / Redis Stack). Mirrors the string adapter's live suite.
 */
const REDIS_STACK_URL = process.env.REDIS_STACK_URL;
describe.skipIf(!REDIS_STACK_URL)("createRedisJSONStorage (live Redis Stack)", () => {
  const prefix = `xtandard-audit-json-test:${Date.now()}`;
  let counter = 0;
  const opened: RedisAuditStorage[] = [];
  let storage: RedisAuditStorage;

  runStorageContractTests(
    "redis JSON (live)",
    () => {
      const s = createRedisJSONStorage({ url: REDIS_STACK_URL, prefix: `${prefix}:${counter++}` });
      opened.push(s);
      return s;
    },
    { expectNativeEventLog: false, timeout: 20_000 },
  );

  beforeAll(() => {
    storage = createRedisJSONStorage({ url: REDIS_STACK_URL, prefix });
    opened.push(storage);
  });

  afterAll(async () => {
    await Promise.all(
      opened.map(async (s) => {
        await Promise.all((await s.getKeys("")).map((k) => s.removeItem(k)));
        await s.close();
      }),
    );
  }, 120_000);

  test("round-trips a nested document as native JSON", async () => {
    const value = { action: "invoice.paid", amount: 42, nested: { tags: ["a", "b"] } };
    await storage.setItem("aud/t/acme/events/000000000001", value);
    expect(await storage.getItem("aud/t/acme/events/000000000001")).toEqual(value);
  });

  test("compareAndSwap compares JSON.GET structurally", async () => {
    const key = "aud/t/cas/head";
    expect(await storage.compareAndSwap({ key, expected: null, next: { seq: 1, hash: "h" } })).toBe(
      true,
    );
    expect(await storage.compareAndSwap({ key, expected: { seq: 9 }, next: { seq: 2 } })).toBe(
      false,
    );
    expect(
      await storage.compareAndSwap({ key, expected: { hash: "h", seq: 1 }, next: { seq: 2 } }),
    ).toBe(true);
    expect(await storage.getItem(key)).toEqual({ seq: 2 });
  });

  test("string and JSON variants must not share keys (WRONGTYPE)", async () => {
    const stringStorage = createRedisStorage({ url: REDIS_STACK_URL, prefix });
    await storage.setItem("typed", { a: 1 }); // JSON type
    await expect(stringStorage.getItem("typed")).rejects.toThrow(/WRONGTYPE/i);
    await stringStorage.close();
  });
});
