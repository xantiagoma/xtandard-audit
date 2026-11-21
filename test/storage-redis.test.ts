import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { asRedisClient, fakeRedis } from "@xtandard/kit/storage/testing";
import { createAuditCore } from "../src/core.ts";
import { createRedisStorage, type RedisAuditStorage } from "../src/storage/redis.ts";
import { hasEventLog, isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const REDIS_URL = process.env.REDIS_URL;
const t = { describe, test, expect };

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
    // Keyspace notifications are off by default (e.g. the CI redis service).
    await probe.configSet("notify-keyspace-events", "KEA");
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
    {
      t,
      capabilities: { compareAndSwap: true, watch: { settleMs: 150 } },
      expectNativeEventLog: false,
      timeout: 20_000,
    },
  );

  test("multiple writers append to one tenant without forking the chain", async () => {
    const { report, head } = await multiWriter(() => {
      const s = createRedisStorage({ url: REDIS_URL, prefix: `${runId}:mw` });
      opened.push(s);
      return s;
    });
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(12);
    expect(head.seq).toBe(12);
  });

  afterAll(async () => {
    await Promise.all(
      opened.map(async (storage) => {
        await Promise.all((await storage.getKeys("")).map((k) => storage.removeItem(k)));
        await storage.close();
      }),
    );
  }, 120_000);
});

describe.skipIf(!available)("createRedisStorage — borrowed client", () => {
  let client: { connect(): Promise<unknown>; quit(): Promise<unknown>; isOpen: boolean };

  beforeAll(async () => {
    const { createClient } = await import("redis");
    client = createClient({ url: REDIS_URL });
    await client.connect();
  });

  test("close() is a no-op for a client the adapter did not create", async () => {
    const storage = createRedisStorage({
      client: client as never,
      prefix: `borrowed:${Date.now()}`,
    });
    await storage.setItem("aud/b/k", { v: 1 });
    expect(await storage.getItem("aud/b/k")).toEqual({ v: 1 });
    await storage.removeItem("aud/b/k");
    await storage.close();
    expect(client.isOpen).toBe(true);
    await client.quit();
  });
});

// The whole contract over the kit's Redis double: exercises prefixing, SCAN,
// watch, the CAS script and the core's CAS-guarded KV event log without a server.
runStorageContractTests(
  "redis (fake client)",
  () => createRedisStorage({ client: asRedisClient(fakeRedis()), prefix: "ns" }),
  { t, capabilities: { compareAndSwap: true, watch: true }, expectNativeEventLog: false },
);

describe("createRedisStorage (fake client)", () => {
  test("multiple writers sharing one keyspace never fork the chain", async () => {
    const shared = asRedisClient(fakeRedis());
    const { report, head } = await multiWriter(() =>
      createRedisStorage({ client: shared, prefix: "mw" }),
    );
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(12);
    expect(head.seq).toBe(12);
  });

  test("values written by v0.1.x (non-canonical JSON) read and swap", async () => {
    const fake = fakeRedis();
    fake.strings.set("ns:aud/t/acme/head", '{"seq":1,"hash":"h"}');
    const storage = createRedisStorage({ client: asRedisClient(fake), prefix: "ns" });
    expect(await storage.getItem("aud/t/acme/head")).toEqual({ seq: 1, hash: "h" });
    expect(
      await storage.compareAndSwap({
        key: "aud/t/acme/head",
        expected: { hash: "h", seq: 1 },
        next: { seq: 2 },
      }),
    ).toBe(true);
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
    expect(typeof storage.close).toBe("function");
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
    expect(hasEventLog(storage)).toBe(false);
  });

  test("close() before any connection is a safe no-op", async () => {
    const storage = createRedisStorage({ url: "redis://localhost:6379" });
    await expect(storage.close()).resolves.toBeUndefined();
  });
});
