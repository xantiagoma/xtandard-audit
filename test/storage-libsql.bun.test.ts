/**
 * Tests the libSQL/Turso adapter's logic against a **real SQL engine** without
 * needing Turso credentials or the `@libsql/client` package: a tiny fake client
 * implementing {@link LibsqlClientLike} backed by `bun:sqlite` runs the exact SQL
 * the adapter emits (KV upserts, LIKE ESCAPE, and the event log's guarded
 * `json_each` inserts in `batch(…, "write")` transactions). It uses
 * `bun:sqlite`, so it runs via `bun test`, not vitest.
 *
 *   bun test test/storage-libsql.bun.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAuditCore } from "../src/core.ts";
import { ChainConflictError } from "../src/storage/contract.ts";
import {
  createLibsqlStorage,
  type LibsqlClientLike,
  type LibsqlAuditStorage,
} from "../src/storage/libsql.ts";
import { runStorageContractTests } from "./storage-contract.ts";

type Binding = string | number | bigint | boolean | null;

/** A `@libsql/client`-shaped client backed by an in-memory `bun:sqlite` database. */
function fakeLibsqlClient(): LibsqlClientLike & { closed: boolean; batches: number } {
  const db = new Database(":memory:");
  const run = (sql: string, args: unknown[] = []) => {
    const stmt = db.query(sql);
    if (stmt.columnNames.length > 0) {
      return { rows: stmt.all(...(args as Binding[])) as Array<Record<string, unknown>> };
    }
    return { rows: [], rowsAffected: stmt.run(...(args as Binding[])).changes };
  };
  const batch = db.transaction((stmts: Array<{ sql: string; args: unknown[] }>) =>
    stmts.map((s) => run(s.sql, s.args)),
  );
  const client = {
    closed: false,
    batches: 0,
    async execute(stmt: string | { sql: string; args: unknown[] }) {
      return typeof stmt === "string" ? run(stmt) : run(stmt.sql, stmt.args);
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>, mode?: string) {
      expect(mode).toBe("write");
      client.batches++;
      return batch.immediate(stmts);
    },
    close() {
      client.closed = true;
      db.close();
    },
  };
  return client;
}

const open: LibsqlAuditStorage[] = [];
const make = (client = fakeLibsqlClient()): LibsqlAuditStorage => {
  const storage = createLibsqlStorage({ client, table: "kv" });
  open.push(storage);
  return storage;
};

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

runStorageContractTests("libsql (bun:sqlite-backed fake client)", () => make(), {
  expectNativeEventLog: true,
});

describe("libsql storage (bun:sqlite-backed fake client)", () => {
  test("returns null for a missing key", async () => {
    expect(await make().getItem("aud/t/acme/missing")).toBeNull();
  });

  test("round-trips an object value", async () => {
    const storage = make();
    const value = { name: "invoice.paid", count: 42, tags: ["a", "b"], nested: { x: 1 } };
    await storage.setItem("aud/actions/invoice.paid", value);
    expect(await storage.getItem("aud/actions/invoice.paid")).toEqual(value);
  });

  test("overwrites an existing key (ON CONFLICT)", async () => {
    const storage = make();
    await storage.setItem("aud/k", { v: 1 });
    await storage.setItem("aud/k", { v: 2 });
    expect(await storage.getItem("aud/k")).toEqual({ v: 2 });
  });

  test("removeItem deletes a key; missing is a no-op", async () => {
    const storage = make();
    await storage.setItem("aud/k", { v: 1 });
    await storage.removeItem("aud/k");
    expect(await storage.getItem("aud/k")).toBeNull();
    await storage.removeItem("aud/nope");
  });

  test("getKeys lists + isolates by prefix (LIKE ESCAPE)", async () => {
    const storage = make();
    await storage.setItem("aud/t/app_1/a", 1);
    await storage.setItem("aud/t/app_1/b", 2);
    await storage.setItem("aud/t/appX1/c", 3);
    expect((await storage.getKeys("aud/t/app_1/")).sort()).toEqual([
      "aud/t/app_1/a",
      "aud/t/app_1/b",
    ]);
    expect(await storage.getKeys("aud/t/none/")).toEqual([]);
  });

  test("event-log writes are single write batches", async () => {
    const client = fakeLibsqlClient();
    const audit = createAuditCore({ storage: make(client) });
    await audit.recordMany([
      { tenant: "b", action: "x.one", actor: { id: "1" }, targets: [{ type: "doc", id: "d" }] },
      { tenant: "b", action: "x.two", actor: { id: "1" } },
    ]);
    expect(client.batches).toBe(1);
  });

  test("a refused append leaves no rows (targets included)", async () => {
    const storage = make();
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

  test("rejects unsafe table names", () => {
    expect(() => createLibsqlStorage({ client: fakeLibsqlClient(), table: "bad; drop" })).toThrow(
      /Invalid table name/,
    );
  });

  test("close() leaves a borrowed client open", async () => {
    const client = fakeLibsqlClient();
    const storage = createLibsqlStorage({ client });
    await storage.setItem("k", 1);
    storage.close();
    expect(client.closed).toBe(false);
    client.close();
  });

  test("requires a client or url", async () => {
    const storage = createLibsqlStorage({});
    await expect(storage.getItem("k")).rejects.toThrow(/client.*or.*url/i);
  });
});
