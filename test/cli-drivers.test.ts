/**
 * The CLI builds its storage from `STORAGE_DRIVER` through its own registry of
 * the audit drivers (so the native event log and the audit defaults reach the
 * CLI). Drivers whose service is not reachable locally are skipped.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildStorage, CLI_DRIVERS } from "../src/cli.ts";
import { hasEventLog } from "../src/storage/contract.ts";

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

/** Whether an optional peer is installed (they are not devDependencies). */
const installed = (pkg: string) => {
  try {
    createRequire(import.meta.url).resolve(pkg);
    return true;
  } catch {
    return false;
  }
};

/** Env each driver needs; `null` = cannot run here (no service / wrong runtime). */
const driverEnv = (driver: string, dir: string): Record<string, string> | null => {
  switch (driver) {
    case "memory":
      return {};
    case "file":
      return { STORAGE_FILE_DIR: join(dir, "file") };
    case "libsql":
      return installed("@libsql/client") ? { LIBSQL_URL: `file:${join(dir, "audit.db")}` } : null;
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
    test.skipIf(driverEnv(driver, "") === null)(
      `builds the ${driver} driver from env`,
      async () => {
        process.env.STORAGE_DRIVER = driver;
        Object.assign(process.env, driverEnv(driver, dir));
        const storage = await buildStorage();
        await storage.setItem("aud/cli-probe", { ok: true });
        expect(await storage.getItem("aud/cli-probe")).toEqual({ ok: true });
        await storage.removeItem("aud/cli-probe");
        await (storage as { close?: () => Promise<void> }).close?.();
      },
    );
  }

  test("the memory driver is audit's: it carries the native event log", async () => {
    process.env.STORAGE_DRIVER = "memory";
    expect(hasEventLog(await buildStorage())).toBe(true);
  });

  test("an unknown driver is an error, not a silent file store", async () => {
    process.env.STORAGE_DRIVER = "unstorage";
    await expect(buildStorage()).rejects.toThrow(/Unknown STORAGE_DRIVER "unstorage"/);
  });
});
