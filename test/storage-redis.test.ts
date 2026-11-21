import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { createRedisStorage, type RedisAuditStorage } from "../src/storage/redis.ts";
import { hasEventLog, isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { fakeRedisClient } from "./redis-fake.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const REDIS_URL = process.env.REDIS_URL;

// Probe a configured server up front (short timeout) so a set-but-unreachable
// REDIS_URL skips the live suites instead of hanging on reconnects.
let available = false;
if (REDIS_URL) {
  const { createClient } = await import("redis");
  const probe = createClient({
    url: REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1500, reconnectStrategy: false },
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
    available = true;
  } catch {
    available = false;
  } finally {
    if (probe.isOpen) await probe.quit().catch(() => {});
  }
}

/** Two independent cores (separate clients, same keyspace) appending to one tenant. */
async function multiWriter(make: () => RedisAuditStorage) {
  const a = make();
  const b = make();
  const coreA = createAuditCore({ storage: a, selfAudit: false });
  const coreB = createAuditCore({ storage: b, selfAudit: false });
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? coreA : coreB).record({ tenant: "shared", action: "x.tick", actor: { id: `${i}` } }),
    ),
  );
  const report = await coreA.verify("shared");
  return { a, b, report, head: await coreB.head("shared") };
}

/**
 * Live conformance suite — runs only when `REDIS_URL` points at a reachable
 * server, so CI without Redis simply skips it. Every `makeStorage` call gets a
 * unique key prefix so each contract test starts empty and never collides with
 * real data; everything is cleaned up and closed in `afterAll`.
 */
describe.skipIf(!available)("redis storage (live conformance)", () => {
  const runId = `xtandard-audit-test:${Date.now()}`;
  let counter = 0;
  const opened: RedisAuditStorage[] = [];

  runStorageContractTests(
    "redis",
    () => {
      const storage = createRedisStorage({ url: REDIS_URL, prefix: `${runId}:${counter++}` });
      opened.push(storage);
      return storage;
    },
    { expectNativeEventLog: false, timeout: 20_000 },
  );

  afterAll(async () => {
    await Promise.all(
      opened.map(async (storage) => {
        await Promise.all((await storage.getKeys("")).map((k) => storage.removeItem(k)));
        await storage.close();
      }),
    );
  }, 120_000);
});

/** Adapter-specific live behaviour (prefix stripping, CAS, multi-writer, watch). */
describe.skipIf(!available)("createRedisStorage (live)", () => {
  const prefix = `xtandard-audit-live:${Date.now()}`;
  const opened: RedisAuditStorage[] = [];
  let storage: RedisAuditStorage;

  beforeAll(() => {
    storage = createRedisStorage({ url: REDIS_URL, prefix });
    opened.push(storage);
  });

  afterAll(async () => {
    await Promise.all((await storage.getKeys("")).map((k) => storage.removeItem(k)));
    for (const s of opened) {
      await Promise.all((await s.getKeys("")).map((k) => s.removeItem(k)));
      await s.close();
    }
  }, 120_000);

  test("getKeys lists matching keys with the prefix stripped", async () => {
    await storage.setItem("aud/t/acme/head", { seq: 1 });
    await storage.setItem("aud/t/acme/checkpoints/chk_1", { v: 2 });
    const keys = await storage.getKeys("aud/t/acme/");
    expect(keys.sort()).toEqual(["aud/t/acme/checkpoints/chk_1", "aud/t/acme/head"]);
    for (const k of keys) expect(k.startsWith(prefix)).toBe(false);
  });

  test("getKeys treats glob metacharacters in the prefix literally", async () => {
    await storage.setItem("aud/t/a*/ix/actor/x", 1);
    await storage.setItem("aud/t/ab/ix/actor/y", 2);
    expect(await storage.getKeys("aud/t/a*/")).toEqual(["aud/t/a*/ix/actor/x"]);
  });

  test("compareAndSwap: absent key, mismatch, structural match", async () => {
    const key = "aud/t/cas/head";
    expect(await storage.compareAndSwap({ key, expected: { seq: 1 }, next: { seq: 2 } })).toBe(
      false,
    );
    expect(await storage.compareAndSwap({ key, expected: null, next: { seq: 1, hash: "h" } })).toBe(
      true,
    );
    expect(await storage.compareAndSwap({ key, expected: null, next: { seq: 9 } })).toBe(false);
    expect(await storage.compareAndSwap({ key, expected: { seq: 0 }, next: { seq: 9 } })).toBe(
      false,
    );
    // Key order does not matter: values are compared structurally.
    expect(
      await storage.compareAndSwap({ key, expected: { hash: "h", seq: 1 }, next: { seq: 2 } }),
    ).toBe(true);
    expect(await storage.getItem(key)).toEqual({ seq: 2 });
  });

  test("multiple writers append to one tenant without forking the chain", async () => {
    const { report, head } = await multiWriter(() => {
      const s = createRedisStorage({ url: REDIS_URL, prefix: `${prefix}:mw` });
      opened.push(s);
      return s;
    });
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(12);
    expect(head.seq).toBe(12);
  });

  test("watch delivers update and remove events (keyspace notifications)", async () => {
    // Keyspace notifications are off by default (e.g. the CI redis service); enable
    // them so this works regardless of the server's startup config.
    const { createClient } = await import("redis");
    const cfg = createClient({ url: REDIS_URL });
    await cfg.connect();
    await cfg.configSet("notify-keyspace-events", "KEA");
    await cfg.quit();

    const events: { type: string; key: string }[] = [];
    const off = await storage.watch("aud/watch/", (e) => events.push(e));
    await storage.setItem("aud/watch/e/k", { v: 1 });
    await storage.removeItem("aud/watch/e/k");
    // Give pub/sub a moment to deliver.
    await new Promise((r) => setTimeout(r, 500));
    off();
    expect(events.some((e) => e.type === "update" && e.key === "aud/watch/e/k")).toBe(true);
    expect(events.some((e) => e.type === "remove" && e.key === "aud/watch/e/k")).toBe(true);
  });
});

describe.skipIf(!available)("createRedisStorage — borrowed client", () => {
  test("close() is a no-op for a client the adapter did not create", async () => {
    const { createClient } = await import("redis");
    const client = createClient({ url: REDIS_URL });
    await client.connect();
    const storage = createRedisStorage({
      client: client as never,
      prefix: `borrowed:${Date.now()}`,
    });
    await storage.setItem("aud/b/k", { v: 1 });
    expect(await storage.getItem("aud/b/k")).toEqual({ v: 1 });
    await storage.removeItem("aud/b/k");
    // close() must NOT disconnect a borrowed client.
    await storage.close();
    expect(client.isOpen).toBe(true);
    // clean up the client ourselves.
    await client.quit();
  });
});

// The whole contract over the fake client: exercises prefixing, SCAN, and the
// core's CAS-guarded KV event log without a server.
runStorageContractTests(
  "redis (fake client)",
  () => createRedisStorage({ client: fakeRedisClient().client, prefix: "ns" }),
  { expectNativeEventLog: false },
);

describe("createRedisStorage (fake client)", () => {
  test("compareAndSwap sends the script, namespaced key and JSON arguments", async () => {
    const { client, strings, evalCalls } = fakeRedisClient();
    const storage = createRedisStorage({ client, prefix: "ns" });
    expect(await storage.compareAndSwap({ key: "aud/k", expected: null, next: { seq: 1 } })).toBe(
      true,
    );
    expect(strings.get("ns:aud/k")).toBe('{"seq":1}');
    expect(evalCalls[0]!.keys).toEqual(["ns:aud/k"]);
    expect(evalCalls[0]!.arguments).toEqual(["1", "", '{"seq":1}']);
    expect(evalCalls[0]!.script).toContain("redis.call('GET', KEYS[1])");
    expect(
      await storage.compareAndSwap({ key: "aud/k", expected: { seq: 0 }, next: { seq: 2 } }),
    ).toBe(false);
    expect(
      await storage.compareAndSwap({ key: "aud/k", expected: { seq: 1 }, next: { seq: 2 } }),
    ).toBe(true);
    expect(await storage.getItem("aud/k")).toEqual({ seq: 2 });
  });

  test("multiple writers sharing one keyspace never fork the chain", async () => {
    const shared = fakeRedisClient().client;
    const { report, head } = await multiWriter(() =>
      createRedisStorage({ client: shared, prefix: "mw" }),
    );
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(12);
    expect(head.seq).toBe(12);
  });

  test("getKeys escapes glob metacharacters in the prefix", async () => {
    const { client } = fakeRedisClient();
    const storage = createRedisStorage({ client, prefix: "ns" });
    await storage.setItem("aud/t/a*/head", 1);
    await storage.setItem("aud/t/ab/head", 2);
    expect(await storage.getKeys("aud/t/a*/")).toEqual(["aud/t/a*/head"]);
  });

  test("getKeys handles scanIterator yielding batched arrays (node-redis v5)", async () => {
    const { client } = fakeRedisClient({ batchScan: true });
    const storage = createRedisStorage({ client, prefix: "x" });
    await storage.setItem("aud/a", 1);
    await storage.setItem("aud/b", 2);
    expect((await storage.getKeys("aud/")).sort()).toEqual(["aud/a", "aud/b"]);
  });
});

/**
 * Type/shape checks that need no live server: a created adapter exposes the
 * full {@link RedisAuditStorage} surface (the contract methods plus watch,
 * compareAndSwap, and close) and no native event log.
 */
describe("createRedisStorage shape", () => {
  test("exposes the AuditStorage + watch + compareAndSwap + close surface without connecting", () => {
    const storage = createRedisStorage({ url: "redis://localhost:6379", prefix: "x" });
    expect(typeof storage.getItem).toBe("function");
    expect(typeof storage.setItem).toBe("function");
    expect(typeof storage.removeItem).toBe("function");
    expect(typeof storage.getKeys).toBe("function");
    expect(typeof storage.close).toBe("function");
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
    expect(hasEventLog(storage)).toBe(false);
  });

  test("close() before any connection is a safe no-op", async () => {
    const storage = createRedisStorage({ url: "redis://localhost:6379" });
    await expect(storage.close()).resolves.toBeUndefined();
  });

  test("onError handler is observable (attaches without throwing)", () => {
    const errors: unknown[] = [];
    const storage = createRedisStorage({
      url: "redis://localhost:6399",
      onError: (e) => errors.push(e),
    });
    expect(typeof storage.close).toBe("function");
  });
});
