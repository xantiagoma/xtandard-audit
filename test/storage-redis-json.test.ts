import { afterAll, describe, expect, test } from "vitest";
import { asRedisClient, fakeRedis } from "@xtandard/kit/storage/testing";
import {
  createRedisJSONStorage,
  createRedisStorage,
  type RedisAuditStorage,
} from "../src/storage/redis.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const t = { describe, test, expect };

// The whole contract over the kit Redis double's RedisJSON store.
runStorageContractTests(
  "redis JSON (fake client)",
  () => createRedisJSONStorage({ client: asRedisClient(fakeRedis()), prefix: "ns" }),
  { t, capabilities: { compareAndSwap: true, watch: true }, expectNativeEventLog: false },
);

/**
 * Integration suite — runs only when `REDIS_JSON_URL` (or the older
 * `REDIS_STACK_URL`) points at a server with the JSON module (Redis 8 / Redis
 * Stack). Mirrors the string adapter's live suite.
 */
const REDIS_JSON_URL = process.env.REDIS_JSON_URL ?? process.env.REDIS_STACK_URL;
describe.skipIf(!REDIS_JSON_URL)("createRedisJSONStorage (live Redis Stack)", () => {
  const prefix = `xtandard-audit-json-test:${Date.now()}`;
  let counter = 0;
  const opened: RedisAuditStorage[] = [];

  runStorageContractTests(
    "redis JSON (live)",
    () => {
      const s = createRedisJSONStorage({ url: REDIS_JSON_URL, prefix: `${prefix}:${counter++}` });
      opened.push(s);
      return s;
    },
    {
      t,
      capabilities: { compareAndSwap: true, watch: { settleMs: 150 } },
      expectNativeEventLog: false,
      timeout: 20_000,
    },
  );

  test("string and JSON variants must not share keys (WRONGTYPE)", async () => {
    const storage = createRedisJSONStorage({ url: REDIS_JSON_URL, prefix });
    const stringStorage = createRedisStorage({ url: REDIS_JSON_URL, prefix });
    opened.push(storage, stringStorage);
    await storage.setItem("typed", { a: 1 }); // JSON type
    await expect(stringStorage.getItem("typed")).rejects.toThrow(/WRONGTYPE/i);
  });

  afterAll(async () => {
    await Promise.all(
      opened.map(async (s) => {
        await Promise.all((await s.getKeys("")).map((k) => s.removeItem(k).catch(() => {})));
        await s.close();
      }),
    );
  }, 120_000);
});
