import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig as getMysqlConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as getPgConfig, text } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteConfig } from "drizzle-orm/sqlite-core";
import { getTableName } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { mysqlAuditEventsTable, mysqlAuditTable, mysqlAuditTables } from "../src/drizzle/mysql.ts";
import {
  pgAuditEventTargetsTable,
  pgAuditEventsTable,
  pgAuditTable,
  pgAuditTables,
} from "../src/drizzle/pg.ts";
import { sqliteAuditTable, sqliteAuditTables } from "../src/drizzle/sqlite.ts";
import { createDrizzleStorage } from "../src/storage/drizzle.ts";
import { ChainConflictError, hasEventLog, isWatchable } from "../src/storage/contract.ts";
import { eventLogDdl } from "../src/storage/sql.ts";
import { runStorageContractTests } from "./storage-contract.ts";

// PGlite boots a WASM Postgres; on a loaded machine that alone can exceed the default 5s.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** One PGlite per file; each test gets its own, uniquely named tables. */
const client = new PGlite();
const db = drizzle(client);
let n = 0;

/**
 * Create the tables the way a consumer's migration would (the adapter issues
 * no DDL) — using the raw Postgres driver's DDL, which the Drizzle factories
 * mirror column for column.
 */
async function freshTables(prefix = "aud") {
  const name = `${prefix}_${n++}`;
  await client.exec(`CREATE TABLE ${name} (key text PRIMARY KEY, value jsonb NOT NULL)`);
  for (const ddl of eventLogDdl("postgres", name)) await client.exec(ddl);
  return pgAuditTables(name);
}

/**
 * Run the shared AuditStorage contract suite against the Drizzle adapter over
 * a Postgres Drizzle database (in-process PGlite), with the native event log.
 * This also proves a real Drizzle db satisfies the adapter's structural `db` type.
 */
runStorageContractTests(
  "drizzle (pg/pglite)",
  async () => createDrizzleStorage({ db, ...(await freshTables()) }),
  { expectNativeEventLog: true },
);

// Without the event tables the adapter is KV-only: the core's generic fallback is used.
runStorageContractTests(
  "drizzle (pg/pglite, KV only)",
  async () => createDrizzleStorage({ db, table: (await freshTables("kvonly")).table }),
  { expectNativeEventLog: false },
);

describe("createDrizzleStorage (pg/pglite)", () => {
  test("round-trips nested values and isolates by prefix (LIKE escaped)", async () => {
    const storage = createDrizzleStorage({ db, ...(await freshTables()) });
    const value = { name: "invoice.paid", count: 42, nested: { tags: ["a", "b"] } };
    await storage.setItem("aud/actions/invoice.paid", value);
    expect(await storage.getItem("aud/actions/invoice.paid")).toEqual(value);

    await storage.setItem("aud/t/app_1/a", { v: 1 });
    await storage.setItem("aud/t/appX1/b", { v: 2 });
    expect(await storage.getKeys("aud/t/app_1/")).toEqual(["aud/t/app_1/a"]);
  });

  test("setItem upserts (second write wins)", async () => {
    const storage = createDrizzleStorage({ db, ...(await freshTables()) });
    await storage.setItem("k", { n: 1 });
    await storage.setItem("k", { n: 2 });
    expect(await storage.getItem("k")).toEqual({ n: 2 });
  });

  test("plain storage is not watchable (watch is composed via withWatch)", async () => {
    const storage = createDrizzleStorage({ db, ...(await freshTables()) });
    expect(isWatchable(storage)).toBe(false);
  });

  test("event tables are all-or-nothing", async () => {
    const { table, events } = await freshTables();
    expect(hasEventLog(createDrizzleStorage({ db, table }))).toBe(false);
    expect(() => createDrizzleStorage({ db, table, events } as never)).toThrow(
      /both `events` and `eventTargets`/,
    );
  });

  test("a stale writer gets ChainConflictError and nothing is written", async () => {
    const storage = createDrizzleStorage({ db, ...(await freshTables()) });
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
    expect((await audit.query({ tenant: "r", targetId: "d1" })).items).toHaveLength(1);
  });

  test("escapes LIKE wildcards in action families and search", async () => {
    const audit = createAuditCore({
      storage: createDrizzleStorage({ db, ...(await freshTables()) }),
    });
    await audit.record({ tenant: "t", action: "a_b.x", actor: { id: "1" }, metadata: { q: "5%" } });
    await audit.record({ tenant: "t", action: "aXb.x", actor: { id: "1" }, metadata: { q: "5" } });
    const actions = async (query: Parameters<typeof audit.query>[0]) =>
      (await audit.query({ tenant: "t", ...query })).items.map((e) => e.action);
    expect(await actions({ actions: ["a_b.*"] })).toEqual(["a_b.x"]);
    expect(await actions({ search: "5%" })).toEqual(["a_b.x"]);
    expect(await actions({ excludeActions: ["a_b.*"] })).toEqual(["aXb.x"]);
  });

  test("large batches are inserted in chunks inside one transaction", async () => {
    const storage = createDrizzleStorage({ db, ...(await freshTables()) });
    const audit = createAuditCore({ storage });
    const events = await audit.recordMany(
      Array.from({ length: 1_100 }, (_, i) => ({
        tenant: "bulk",
        action: "x.tick",
        actor: { id: String(i) },
        targets: [{ type: "n", id: String(i) }],
      })),
    );
    expect(events.at(-1)!.seq).toBe(1_100);
    expect(await storage.countEvents("bulk")).toBe(1_100);
    expect((await audit.query({ tenant: "bulk", targetId: "1099" })).items).toHaveLength(1);
  });
});

describe("table factories — shape", () => {
  test("all three dialects expose key + value columns", () => {
    for (const t of [pgAuditTable("kv"), mysqlAuditTable("kv"), sqliteAuditTable("kv")]) {
      expect(t.key).toBeDefined();
      expect(t.value).toBeDefined();
    }
  });

  test("table names default to xtandard_audit[_events|_event_targets]", () => {
    expect(getTableName(pgAuditTable())).toBe("xtandard_audit");
    expect(getTableName(mysqlAuditTable())).toBe("xtandard_audit");
    expect(getTableName(sqliteAuditTable())).toBe("xtandard_audit");
    expect(getTableName(pgAuditEventsTable())).toBe("xtandard_audit_events");
    expect(getTableName(pgAuditEventTargetsTable())).toBe("xtandard_audit_event_targets");
    for (const tables of [pgAuditTables("a"), mysqlAuditTables("a"), sqliteAuditTables("a")]) {
      expect(Object.values(tables).map(getTableName)).toEqual(["a", "a_events", "a_event_targets"]);
    }
  });

  test("events tables carry the primary key, unique id and query indexes", () => {
    const pg = getPgConfig(pgAuditTables("x", { schema: "audit" }).events as never);
    expect(pg.schema).toBe("audit");
    expect(pg.primaryKeys[0]!.columns.map((c) => c.name)).toEqual(["tenant", "seq"]);
    expect(pg.uniqueConstraints[0]!.columns.map((c) => c.name)).toEqual(["tenant", "id"]);
    expect(pg.indexes.map((i) => i.config.name)).toEqual([
      "x_events_time_idx",
      "x_events_actor_idx",
      "x_events_action_idx",
    ]);
    expect(pg.columns.find((c) => c.name === "occurred_at")!.getSQLType()).toBe(`text COLLATE "C"`);
    const my = getMysqlConfig(mysqlAuditEventsTable() as never);
    expect(my.columns.find((c) => c.name === "actor_id")!.getSQLType()).toMatch(/utf8mb4_bin/);
    expect(getMysqlConfig(mysqlAuditTable() as never).columns[0]!.getSQLType()).toMatch(
      /varchar\(512\).*utf8mb4_bin/,
    );
    const lite = getSqliteConfig(sqliteAuditTables().eventTargets as never);
    expect(lite.indexes.map((i) => i.config.name)).toEqual([
      "xtandard_audit_event_targets_target_idx",
      "xtandard_audit_event_targets_seq_idx",
    ]);
  });

  test("extraColumns merges additional columns onto the KV table", () => {
    const t = pgAuditTable("kv", { extraColumns: () => ({ tenantId: text("tenant_id") }) });
    expect((t as unknown as Record<string, unknown>).tenantId).toBeDefined();
    // Accepting extraIndexes must not throw (Drizzle invokes it lazily at SQL-gen).
    expect(() => pgAuditTable("kv", { extraIndexes: () => [] })).not.toThrow();
  });
});
