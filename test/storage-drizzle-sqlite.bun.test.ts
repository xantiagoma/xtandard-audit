/**
 * The Drizzle adapter over a **synchronous** SQLite Drizzle database
 * (`drizzle-orm/bun-sqlite`): exercises the sync-transaction path and the
 * case-sensitive GLOB action families. Runs via `bun test` (`bun:sqlite`).
 *
 *   bun test test/storage-drizzle-sqlite.bun.test.ts
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createAuditCore } from "../src/core.ts";
import { sqliteAuditTables } from "../src/drizzle/sqlite.ts";
import { ChainConflictError } from "../src/storage/contract.ts";
import { createDrizzleStorage } from "../src/storage/drizzle.ts";
import { eventLogDdl } from "../src/storage/sql.ts";
import { runStorageContractTests } from "./storage-contract.ts";

/** A fresh in-memory database with the tables a migration would create. */
function fresh() {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE audit (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const ddl of eventLogDdl("sqlite", "audit")) sqlite.run(ddl);
  return createDrizzleStorage({ db: drizzle(sqlite), ...sqliteAuditTables("audit") });
}

runStorageContractTests("drizzle (sqlite/bun-sqlite)", fresh, { expectNativeEventLog: true });

describe("createDrizzleStorage (sqlite/bun-sqlite)", () => {
  test("action families are case-sensitive (GLOB, not LIKE)", async () => {
    const audit = createAuditCore({ storage: fresh() });
    await audit.record({ tenant: "t", action: "invoice.paid", actor: { id: "1" } });
    await audit.record({ tenant: "t", action: "Invoice.paid", actor: { id: "1" } });
    const page = await audit.query({ tenant: "t", actions: ["invoice.*"] });
    expect(page.items.map((e) => e.action)).toEqual(["invoice.paid"]);
  });

  test("a refused append rolls back the sync transaction", async () => {
    const storage = fresh();
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
    expect(await storage.countEvents("r")).toBe(1);
    expect((await audit.query({ tenant: "r", targetId: "d1" })).items).toHaveLength(1);
  });
});
