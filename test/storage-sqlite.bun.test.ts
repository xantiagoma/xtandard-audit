/**
 * Bun-native test for the SQLite adapter (`bun:sqlite` is unavailable under Node,
 * so this runs via `bun test`, not vitest — it is excluded from the vitest glob).
 *
 *   bun test test/storage-sqlite.bun.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAuditCore } from "../src/core.ts";
import { ChainConflictError } from "../src/storage/contract.ts";
import { createSqliteStorage, type SqliteAuditStorage } from "../src/storage/sqlite.ts";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests("sqlite (bun:sqlite)", () => createSqliteStorage({ table: "kv" }), {
  expectNativeEventLog: true,
});

let storage: SqliteAuditStorage;

beforeEach(() => {
  storage = createSqliteStorage({ table: "kv" }); // in-memory
});
afterEach(() => {
  storage.close();
});

describe("sqlite storage", () => {
  test("round-trips objects and returns null for missing keys", async () => {
    expect(await storage.getItem("nope")).toBeNull();
    await storage.setItem("aud/actions/invoice.paid", { name: "invoice.paid", tags: ["a"] });
    expect(await storage.getItem("aud/actions/invoice.paid")).toEqual({
      name: "invoice.paid",
      tags: ["a"],
    });
  });

  test("setItem overwrites", async () => {
    await storage.setItem("k", "one");
    await storage.setItem("k", "two");
    expect(await storage.getItem("k")).toBe("two");
  });

  test("removeItem deletes", async () => {
    await storage.setItem("k", 1);
    await storage.removeItem("k");
    expect(await storage.getItem("k")).toBeNull();
  });

  test("getKeys filters by prefix and escapes LIKE wildcards", async () => {
    await storage.setItem("aud/t/a_1/x", 1);
    await storage.setItem("aud/t/a_1/y", 2);
    await storage.setItem("aud/t/aX1/z", 3);
    expect((await storage.getKeys("aud/t/a_1/")).sort()).toEqual(["aud/t/a_1/x", "aud/t/a_1/y"]);
  });

  test("creates the KV and event-log tables", () => {
    const db = new Database(":memory:");
    createSqliteStorage({ database: db, table: "audit" });
    const names = db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toEqual(["audit", "audit_event_targets", "audit_events"]);
    db.close();
  });

  test("action families are case-sensitive (GLOB, not LIKE)", async () => {
    const audit = createAuditCore({ storage });
    await audit.record({ tenant: "t", action: "invoice.paid", actor: { id: "1" } });
    await audit.record({ tenant: "t", action: "Invoice.paid", actor: { id: "1" } });
    await audit.record({ tenant: "t", action: "in_voice.paid", actor: { id: "1" } });
    const actions = async (list: string[]) =>
      (await audit.query({ tenant: "t", actions: list })).items.map((e) => e.action);
    expect(await actions(["invoice.*"])).toEqual(["invoice.paid"]);
    expect(await actions(["in_voice.*"])).toEqual(["in_voice.paid"]);
  });

  test("a stale writer gets ChainConflictError and nothing is written", async () => {
    const audit = createAuditCore({ storage });
    const e1 = await audit.record({
      tenant: "r",
      action: "x.y",
      actor: { id: "1" },
      targets: [{ type: "doc", id: "d1" }],
    });
    await expect(storage.appendEvents("r", [e1], { expectedSeq: 0 })).rejects.toBeInstanceOf(
      ChainConflictError,
    );
    await expect(
      storage.appendEvents("r", [{ ...e1, id: "evt_ahead", seq: 6 }], { expectedSeq: 5 }),
    ).rejects.toBeInstanceOf(ChainConflictError);
    expect(await storage.countEvents("r")).toBe(1);
    // No orphan target rows were left behind by the refused appends.
    expect((await audit.query({ tenant: "r", targetId: "d1" })).items).toHaveLength(1);
  });

  test("rejects unsafe table names", () => {
    expect(() => createSqliteStorage({ table: "bad; drop table" })).toThrow(/Invalid table name/);
  });

  test("a borrowed database is not closed", async () => {
    const db = new Database(":memory:");
    const s = createSqliteStorage({ database: db });
    await s.setItem("k", 1);
    s.close();
    expect(db.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
    db.close();
  });

  test("persists events across instances sharing a file", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(tmpdir(), `audit-sqlite-${Date.now()}.db`);
    const a = createSqliteStorage({ path, table: "kv" });
    await a.setItem("k", { v: 42 });
    await createAuditCore({ storage: a }).record({
      tenant: "p",
      action: "x.y",
      actor: { id: "1" },
    });
    a.close();
    const b = createSqliteStorage({ path, table: "kv" });
    expect(await b.getItem("k")).toEqual({ v: 42 });
    expect((await createAuditCore({ storage: b }).verify("p")).ok).toBe(true);
    b.close();
  });
});
