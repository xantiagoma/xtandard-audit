import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { hasEventLog, isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests("memory", () => createMemoryStorage(), { expectNativeEventLog: true });

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
  { expectNativeEventLog: false },
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

  it("clones on read and write (no shared references)", async () => {
    const storage = createMemoryStorage();
    const value = { nested: { count: 1 } };
    await storage.setItem("aud/k", value);
    value.nested.count = 99;
    const read = await storage.getItem<typeof value>("aud/k");
    expect(read?.nested.count).toBe(1);
    read!.nested.count = 42;
    expect((await storage.getItem<typeof value>("aud/k"))?.nested.count).toBe(1);
  });

  it("watch fires on update and remove, filtered by prefix", async () => {
    const storage = createMemoryStorage();
    const events: string[] = [];
    const unsubscribe = await storage.watch("aud/acme/", (e) => events.push(`${e.type}:${e.key}`));
    await storage.setItem("aud/acme/a", 1);
    await storage.setItem("aud/other/b", 2);
    await storage.removeItem("aud/acme/a");
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["update:aud/acme/a", "remove:aud/acme/a"]);
    unsubscribe();
    await storage.setItem("aud/acme/c", 3);
    await new Promise((r) => setTimeout(r, 0));
    expect(events.length).toBe(2);
  });

  it("compareAndSwap succeeds only when expectations hold", async () => {
    const storage = createMemoryStorage();
    // Missing key: expected null wins, anything else loses.
    expect(await storage.compareAndSwap({ key: "aud/k", expected: { v: 1 }, next: { v: 2 } })).toBe(
      false,
    );
    expect(await storage.compareAndSwap({ key: "aud/k", expected: null, next: { v: 1 } })).toBe(
      true,
    );
    // Present key: deep equality decides.
    expect(await storage.compareAndSwap({ key: "aud/k", expected: { v: 0 }, next: { v: 2 } })).toBe(
      false,
    );
    expect(await storage.compareAndSwap({ key: "aud/k", expected: { v: 1 }, next: { v: 2 } })).toBe(
      true,
    );
    expect(await storage.getItem("aud/k")).toEqual({ v: 2 });
  });
});
