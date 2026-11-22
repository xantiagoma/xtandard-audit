import { drizzle } from "drizzle-orm/mysql2";
import { getTableConfig, type MySqlTable } from "drizzle-orm/mysql-core";
import mysql from "mysql2/promise";
import { afterAll, describe, expect, test } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { mysqlAuditTables, type MysqlAuditTableOptions } from "../src/drizzle/mysql.ts";
import type { DrizzleAuditTables } from "../src/drizzle/table.ts";
import { createDrizzleStorage, KeyCollisionError } from "../src/storage/drizzle.ts";
import { runStorageContractTests } from "./storage-contract.ts";

/**
 * Live MySQL suite for the Drizzle adapter (`drizzle-orm/mysql2`) — runs the
 * full contract when a MySQL 8 server is reachable at `MYSQL_URL` and skips
 * otherwise (CI provides a `mysql:8` service). Each run works in its own
 * database, dropped in `afterAll`.
 */
const MYSQL_URL = process.env.MYSQL_URL ?? "mysql://root:root@127.0.0.1:3306/audit";

// Detect a reachable MySQL up front (short timeout) so machines without a server
// simply skip the live suite instead of hanging on connection attempts.
let available = false;
{
  try {
    const probe = await mysql.createConnection({ uri: MYSQL_URL, connectTimeout: 1500 });
    await probe.query("SELECT 1");
    await probe.end();
    available = true;
  } catch {
    available = false;
  }
}

const dbName = `audit_test_${Date.now()}`;
let pool: mysql.Pool | undefined;

async function getPool(): Promise<mysql.Pool> {
  if (pool) return pool;
  const admin = await mysql.createConnection({ uri: MYSQL_URL });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await admin.end();
  pool = mysql.createPool({ uri: MYSQL_URL, database: dbName, connectionLimit: 8 });
  return pool;
}

/**
 * `CREATE TABLE` from a Drizzle table's own config — so this suite also checks
 * that the `mysqlAudit*Table` factories produce a valid, working schema.
 */
function createTableSql(table: MySqlTable): string {
  const c = getTableConfig(table);
  const q = (name: string) => `\`${name}\``;
  const parts = c.columns.map(
    (col) =>
      `${q(col.name)} ${col.getSQLType()}${col.notNull ? " NOT NULL" : ""}${col.primary ? " PRIMARY KEY" : ""}`,
  );
  for (const pk of c.primaryKeys) {
    parts.push(`PRIMARY KEY (${pk.columns.map((x) => q(x.name)).join(", ")})`);
  }
  for (const u of c.uniqueConstraints) {
    parts.push(`UNIQUE KEY ${q(u.name!)} (${u.columns.map((x) => q(x.name)).join(", ")})`);
  }
  for (const i of c.indexes) {
    const cols = i.config.columns.map((x) => q((x as { name: string }).name));
    parts.push(`KEY ${q(i.config.name)} (${cols.join(", ")})`);
  }
  return `CREATE TABLE ${q(c.name)} (${parts.join(", ")})`;
}

let n = 0;
async function freshTables(
  keyCollation?: MysqlAuditTableOptions["keyCollation"],
): Promise<{ db: unknown } & DrizzleAuditTables> {
  const p = await getPool();
  const tables = mysqlAuditTables(`aud_${n++}`, keyCollation ? { keyCollation } : {});
  for (const t of Object.values(tables)) await p.query(createTableSql(t as MySqlTable));
  // `mysql2/promise` and `mysql2` ship separate (incompatible) Pool typings; the runtime object is the same.
  return { db: drizzle(p as never), ...tables };
}

afterAll(async () => {
  if (!pool) return;
  await pool.end();
  const admin = await mysql.createConnection({ uri: MYSQL_URL });
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.end();
}, 120_000);

describe.skipIf(!available)("createDrizzleStorage (mysql, live)", () => {
  // The KV conformance suite on the default key column (utf8mb4_bin, PAD SPACE): keys that differ
  // only by trailing spaces collide there, so the case expects `KeyCollisionError` (padSpaceKeys).
  runStorageContractTests(
    "drizzle (mysql)",
    async () => createDrizzleStorage(await freshTables()),
    {
      t: { describe, test, expect },
      capabilities: { compareAndSwap: true, watch: false, padSpaceKeys: true },
      expectNativeEventLog: true,
      timeout: 30_000,
    },
  );

  test(
    "the default utf8mb4_bin key names the stored spelling in KeyCollisionError",
    { timeout: 30_000 },
    async () => {
      const storage = createDrizzleStorage(await freshTables());
      await storage.setItem("aud/k/a", { v: 1 });
      const error = await storage.setItem("aud/k/a ", { v: 2 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KeyCollisionError);
      expect((error as KeyCollisionError).storedKey).toBe("aud/k/a");
    },
  );

  test(
    "a NO PAD key (utf8mb4_0900_bin) keeps keys differing by trailing spaces distinct",
    { timeout: 30_000 },
    async () => {
      const storage = createDrizzleStorage(await freshTables("utf8mb4_0900_bin"));
      const keys = ["aud/k/a", "aud/k/a ", "aud/k/a  "];
      for (const [i, k] of keys.entries()) await storage.setItem(k, { i });
      for (const [i, k] of keys.entries()) expect(await storage.getItem(k)).toEqual({ i });
      expect((await storage.getKeys("aud/k/")).sort()).toEqual([...keys].sort());
      await storage.removeItem("aud/k/a ");
      expect(await storage.getItem("aud/k/a")).toEqual({ i: 0 });
      expect(await storage.getItem("aud/k/a  ")).toEqual({ i: 2 });
    },
  );

  test("keys and filters are case-sensitive (utf8mb4_bin)", { timeout: 30_000 }, async () => {
    const storage = createDrizzleStorage(await freshTables());
    await storage.setItem("aud/t/Acme/head", { seq: 1 });
    await storage.setItem("aud/t/acme/head", { seq: 2 });
    expect(await storage.getItem("aud/t/Acme/head")).toEqual({ seq: 1 });
    expect(await storage.getKeys("aud/t/acme/")).toEqual(["aud/t/acme/head"]);

    const audit = createAuditCore({ storage });
    await audit.record({ tenant: "t", action: "invoice.paid", actor: { id: "U_1" } });
    await audit.record({ tenant: "t", action: "Invoice.paid", actor: { id: "u_1" } });
    const actions = async (query: Parameters<typeof audit.query>[0]) =>
      (await audit.query({ tenant: "t", ...query })).items.map((e) => e.action);
    expect(await actions({ actorId: "u_1" })).toEqual(["Invoice.paid"]);
    expect(await actions({ actions: ["invoice.*"] })).toEqual(["invoice.paid"]);
  });

  test("two cores on one database never fork a tenant's chain", { timeout: 30_000 }, async () => {
    const storage = createDrizzleStorage(await freshTables());
    const a = createAuditCore({ storage });
    const b = createAuditCore({ storage });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? a : b).record({ tenant: "m", action: "x.tick", actor: { id: String(i) } }),
      ),
    );
    const report = await a.verify("m");
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(12);
  });
});
