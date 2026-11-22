import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createUnstorageStorage } from "../src/storage/unstorage.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests(
  "unstorage (memory driver)",
  () => createUnstorageStorage({ storage: createStorage() }),
  {
    t: { describe, test, expect },
    capabilities: { compareAndSwap: false, watch: false },
    expectNativeEventLog: false,
  },
);

describe("createUnstorageStorage specifics", () => {
  test("escaped key segments survive the separator round-trip", async () => {
    const storage = createUnstorageStorage({ storage: createStorage() });
    // The core escapes free-form segments (`encodeURIComponent`), so `:` and `/`
    // in a tenant id never reach unstorage as separators.
    const key = `aud/t/${encodeURIComponent("org:1/eu")}/head`;
    await storage.setItem(key, { seq: 1 });
    expect(await storage.getKeys("aud/t/")).toEqual([key]);
    expect(await storage.getItem(key)).toEqual({ seq: 1 });
  });

  test("keys written by v0.1.x read back", async () => {
    // Earlier releases stored values through unstorage verbatim, under the escaped key.
    const raw = createStorage();
    await raw.setItem("aud/t/acme%3Aeu/head", { seq: 3 });
    const storage = createUnstorageStorage({ storage: raw });
    expect(await storage.getItem("aud/t/acme:eu/head")).toEqual({ seq: 3 });
    expect(await storage.getKeys("aud/t/")).toEqual(["aud/t/acme:eu/head"]);
  });
});
