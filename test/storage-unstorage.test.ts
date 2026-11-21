import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createUnstorageStorage } from "../src/storage/unstorage.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests(
  "unstorage (memory driver)",
  () => createUnstorageStorage({ storage: createStorage() }),
  { expectNativeEventLog: false },
);

describe("createUnstorageStorage specifics", () => {
  test("getKeys returns slash-separated keys, not unstorage's colon form", async () => {
    const storage = createUnstorageStorage({ storage: createStorage() });
    await storage.setItem("aud/t/acme/checkpoints/chk_1", { v: 1 });
    await storage.setItem("aud/t/acme/head", { key: "acme" });
    const keys = await storage.getKeys("aud/t/acme/");
    expect(keys.sort()).toEqual(["aud/t/acme/checkpoints/chk_1", "aud/t/acme/head"]);
    for (const k of keys) expect(k).not.toContain(":");
  });

  test("escaped key segments survive the separator round-trip", async () => {
    const storage = createUnstorageStorage({ storage: createStorage() });
    // The core escapes free-form segments (`encodeURIComponent`), so `:` and `/`
    // in a tenant id never reach unstorage as separators.
    const key = `aud/t/${encodeURIComponent("org:1/eu")}/head`;
    await storage.setItem(key, { seq: 1 });
    expect(await storage.getKeys("aud/t/")).toEqual([key]);
    expect(await storage.getItem(key)).toEqual({ seq: 1 });
  });

  test("auto-deserializes JSON values and yields null for missing", async () => {
    const storage = createUnstorageStorage({ storage: createStorage() });
    expect(await storage.getItem("aud/t/acme/none")).toBeNull();
    await storage.setItem("aud/t/acme/obj", { nested: { ok: true } });
    expect(await storage.getItem("aud/t/acme/obj")).toEqual({ nested: { ok: true } });
  });
});
