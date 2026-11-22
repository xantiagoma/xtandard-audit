import { describe, expect, it, test } from "vitest";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { hasEventLog, isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const t = { describe, test, expect };

runStorageContractTests("memory", () => createMemoryStorage(), {
  t,
  capabilities: { compareAndSwap: true, watch: true },
  expectNativeEventLog: true,
});

// The same memory map, stripped to the four KV methods + CAS: exercises the core's generic
// KV event-log fallback (the path file/redis/unstorage/cloudflare-kv take).
runStorageContractTests(
  "memory (KV fallback)",
  () => {
    const m = createMemoryStorage();
    return {
      getItem: m.getItem,
      setItem: m.setItem,
      removeItem: m.removeItem,
      getKeys: m.getKeys,
      compareAndSwap: m.compareAndSwap,
    };
  },
  { t, capabilities: { compareAndSwap: true, watch: false }, expectNativeEventLog: false },
);

describe("memory storage extras", () => {
  it("implements every optional capability", () => {
    const storage = createMemoryStorage();
    expect(isWatchable(storage)).toBe(true);
    expect(isCompareAndSwap(storage)).toBe(true);
    expect(hasEventLog(storage)).toBe(true);
  });

  it("seeds initial data", async () => {
    const storage = createMemoryStorage({ initial: { "aud/acme/metadata": { key: "acme" } } });
    expect(await storage.getItem("aud/acme/metadata")).toEqual({ key: "acme" });
  });
});
