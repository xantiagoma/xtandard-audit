import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
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
  t: { describe, test, expect },
  capabilities: { compareAndSwap: true, watch: { settleMs: 200 } },
  expectNativeEventLog: false,
});

describe("file storage extras", () => {
  it("is watchable and compare-and-swap capable, KV-only", () => {
    const storage = createFileStorage({ dir: freshDir() });
    expect(isWatchable(storage)).toBe(true);
    expect(hasEventLog(storage)).toBe(false);
    expect(isCompareAndSwap(storage)).toBe(true);
  });

  it("keeps the case-safe layout every release wrote (tenants Acme and acme)", async () => {
    const dir = freshDir();
    const storage = createFileStorage({ dir });
    await storage.setItem("aud/t/Acme/head", { seq: 1 });
    await storage.setItem("aud/t/acme/head", { seq: 2 });
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(join(dir, "aud", "t", "^acme", "head.json"), "utf8"))).toEqual(
      {
        seq: 1,
      },
    );
    expect(await storage.getItem("aud/t/acme/head")).toEqual({ seq: 2 });
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
});
