/**
 * The CLI builds its storage from `STORAGE_DRIVER` by dynamically importing
 * the driver's subpath entry. Drivers whose entry is not in this checkout (or
 * whose service is not reachable locally) are skipped — the suite stays green
 * while storage drivers land independently.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStorage, CLI_DRIVERS } from "../src/cli.ts";

const ENV = [
  "STORAGE_DRIVER",
  "STORAGE_FILE_DIR",
  "STORAGE_SQLITE_PATH",
  "LIBSQL_URL",
  "REDIS_URL",
  "POSTGRES_URL",
  "DATABASE_URL",
  "MONGO_URL",
];
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "audit-cli-drivers-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const hasEntry = (driver: string) =>
  existsSync(fileURLToPath(new URL(`../src/entry-storage-${driver}.ts`, import.meta.url)));

/** Env each driver needs; `null` = cannot run here (no service / wrong runtime). */
const driverEnv = (driver: string, dir: string): Record<string, string> | null => {
  switch (driver) {
    case "memory":
      return {};
    case "file":
      return { STORAGE_FILE_DIR: join(dir, "file") };
    case "libsql":
      return { LIBSQL_URL: `file:${join(dir, "audit.db")}` };
    case "redis":
      return process.env.REDIS_URL ? {} : null;
    case "postgres":
      return process.env.POSTGRES_URL ? {} : null;
    case "mongodb":
      return process.env.MONGO_URL ? {} : null;
    default:
      return null; // sqlite needs the Bun runtime (bun:sqlite)
  }
};

describe("cli storage drivers", () => {
  for (const driver of CLI_DRIVERS) {
    const runnable = hasEntry(driver) && driverEnv(driver, "") !== null;
    test.skipIf(!runnable)(`builds the ${driver} driver from env`, async () => {
      process.env.STORAGE_DRIVER = driver;
      Object.assign(process.env, driverEnv(driver, dir));
      const storage = await buildStorage();
      await storage.setItem("aud/cli-probe", { ok: true });
      expect(await storage.getItem("aud/cli-probe")).toEqual({ ok: true });
      await storage.removeItem("aud/cli-probe");
      await (storage as { close?: () => Promise<void> }).close?.();
    });

    test.skipIf(hasEntry(driver))(`reports the ${driver} driver as unavailable`, async () => {
      process.env.STORAGE_DRIVER = driver;
      await expect(buildStorage()).rejects.toThrow(`missing @xtandard/audit/storage/${driver}`);
    });
  }
});
