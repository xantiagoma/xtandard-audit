import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hasEventLog, isCompareAndSwap, isWatchable } from "../src/storage/contract.ts";
import { clearFileStorage, createFileStorage } from "../src/storage/file.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const roots: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xtandard-audit-file-"));
  roots.push(dir);
  return join(dir, "store");
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => clearFileStorage({ dir })));
});

runStorageContractTests("file", () => createFileStorage({ dir: freshDir() }), {
  expectNativeEventLog: false,
});

describe("file storage extras", () => {
  it("is watchable, KV-only, without compare-and-swap", () => {
    const storage = createFileStorage({ dir: freshDir() });
    expect(isWatchable(storage)).toBe(true);
    expect(hasEventLog(storage)).toBe(false);
    expect(isCompareAndSwap(storage)).toBe(false);
  });

  it("getKeys on a missing base dir returns empty", async () => {
    const storage = createFileStorage({ dir: freshDir() });
    expect(await storage.getKeys("aud/")).toEqual([]);
  });

  it("clearFileStorage removes everything", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    await storage.setItem("aud/t/acme/head", { seq: 1 });
    await clearFileStorage({ dir });
    expect(await storage.getKeys("aud/")).toEqual([]);
  });

  it("persists across instances pointed at the same dir", async () => {
    const dir = freshDir();
    await createFileStorage({ dir }).setItem("aud/t/acme/head", { seq: 7 });
    expect(await createFileStorage({ dir }).getItem("aud/t/acme/head")).toEqual({ seq: 7 });
  });

  it("writes atomically: no temp files are left behind", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storage.setItem("aud/t/acme/head", { seq: i })),
    );
    expect(readdirSync(join(dir, "aud", "t", "acme"))).toEqual(["head.json"]);
    expect(await storage.getItem("aud/t/acme/head")).toMatchObject({ seq: expect.any(Number) });
  });

  it("watch reports updates and removals under the prefix", async () => {
    const storage = createFileStorage({ dir: freshDir() });
    const events: string[] = [];
    const off = await storage.watch("aud/t/acme/", (e) => events.push(`${e.type}:${e.key}`));
    try {
      await storage.setItem("aud/t/acme/head", { seq: 1 });
      await storage.setItem("aud/t/other/head", { seq: 1 });
      await waitFor(() => events.includes("update:aud/t/acme/head"));
      await storage.removeItem("aud/t/acme/head");
      await waitFor(() => events.includes("remove:aud/t/acme/head"));
      expect(events.every((e) => e.endsWith("aud/t/acme/head"))).toBe(true);
    } finally {
      off();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for watch event");
    await new Promise((r) => setTimeout(r, 20));
  }
}
