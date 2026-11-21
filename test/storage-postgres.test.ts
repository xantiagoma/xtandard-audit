import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { ChainConflictError, hasEventLog } from "../src/storage/contract.ts";
import { createPostgresStorage, type PostgresAuditStorage } from "../src/storage/postgres.ts";
import { runStorageContractTests, seedEvents } from "./storage-contract.ts";

// PGlite boots a WASM Postgres; on a loaded machine that alone can exceed the default 5s.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * One in-process PGlite per file (booting one is the slow part); every test
 * gets fresh, uniquely named tables in it for isolation.
 */
const pglite = new PGlite();
let n = 0;
const fresh = (prefix = "t") =>
  createPostgresStorage({ client: pglite, table: `${prefix}_${n++}` });

/**
 * Run the shared {@link AuditStorage} contract suite against the Postgres
 * adapter, backed by in-process PGlite so no server is required and the tests
 * always run.
 */
runStorageContractTests("postgres (pglite)", () => fresh("kv"), { expectNativeEventLog: true });

/** Adapter-specific behaviour against in-process PGlite. */
describe("createPostgresStorage (pglite)", () => {
  let storage: PostgresAuditStorage;

  beforeAll(() => {
    storage = fresh("audit_test");
  });

  test("round-trips a nested object value", async () => {
    const value = { action: "invoice.paid", count: 42, tags: ["a", "b"], nested: { x: 1 } };
    await storage.setItem("aud/actions/invoice.paid", value);
    expect(await storage.getItem("aud/actions/invoice.paid")).toEqual(value);
  });

  test("returns null for a missing key", async () => {
    expect(await storage.getItem("aud/t/acme/does-not-exist")).toBeNull();
  });

  test("isolates by prefix and escapes LIKE wildcards", async () => {
    await storage.setItem("aud/t/app_1/a", { v: 1 });
    await storage.setItem("aud/t/appX1/b", { v: 2 });
    expect(await storage.getKeys("aud/t/app_1/")).toEqual(["aud/t/app_1/a"]);
    expect(await storage.getKeys("aud/t/appX1/")).toEqual(["aud/t/appX1/b"]);
  });

  test("creates the KV and event-log tables lazily, once", async () => {
    const client = pglite;
    const s = createPostgresStorage({ client, table: "lazy" });
    const tables = async () =>
      (
        await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE tablename LIKE 'lazy%' ORDER BY tablename`,
        )
      ).rows.map((r) => r.tablename);
    expect(await tables()).toEqual([]);
    await Promise.all([s.getItem("a"), s.countEvents(), s.getKeys("")]);
    expect(await tables()).toEqual(["lazy", "lazy_event_targets", "lazy_events"]);
  });

  test("stores denormalized columns the native query relies on", async () => {
    const client = pglite;
    const s = createPostgresStorage({ client, table: "cols" });
    await seedEvents(s);
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT seq, action, actor_id, actor_type, outcome FROM cols_events
       WHERE tenant = 'acme' AND seq <= 2 ORDER BY seq`,
    );
    expect(rows).toEqual([
      { seq: 1, action: "user.login", actor_id: "u_1", actor_type: "user", outcome: null },
      { seq: 2, action: "invoice.paid", actor_id: "u_2", actor_type: "api_key", outcome: null },
    ]);
    const targets = await client.query(`SELECT type, target_id FROM cols_event_targets`);
    expect(targets.rows).toHaveLength(4);
  });

  test("escapes LIKE wildcards in action families and search", async () => {
    const s = fresh("esc");
    const audit = createAuditCore({ storage: s });
    await audit.record({
      tenant: "t",
      action: "a_b.x",
      actor: { id: "1" },
      metadata: { q: "50%" },
    });
    await audit.record({ tenant: "t", action: "aXb.x", actor: { id: "1" }, metadata: { q: "50" } });
    const actions = async (query: Parameters<typeof audit.query>[0]) =>
      (await audit.query({ tenant: "t", ...query })).items.map((e) => e.action);
    expect(await actions({ actions: ["a_b.*"] })).toEqual(["a_b.x"]);
    expect(await actions({ search: "50%" })).toEqual(["a_b.x"]);
  });

  test("a stale writer gets ChainConflictError and nothing is written", async () => {
    const s = fresh("race");
    const a = createAuditCore({ storage: s });
    const e1 = await a.record({ tenant: "r", action: "x.y", actor: { id: "1" } });
    // A batch continuing from seq 0 again collides on (tenant, seq) / the head guard.
    await expect(s.appendEvents("r", [e1], { expectedSeq: 0 })).rejects.toBeInstanceOf(
      ChainConflictError,
    );
    // A batch claiming to continue from a seq ahead of the table is refused too.
    await expect(
      s.appendEvents("r", [{ ...e1, id: "evt_ahead", seq: 6 }], { expectedSeq: 5 }),
    ).rejects.toBeInstanceOf(ChainConflictError);
    // Non-contiguous seqs are rejected before touching the database.
    await expect(
      s.appendEvents("r", [{ ...e1, seq: 3 }], { expectedSeq: 1 }),
    ).rejects.toBeInstanceOf(ChainConflictError);
    expect(await s.countEvents("r")).toBe(1);
  });

  test("two cores on one database never fork a tenant's chain", async () => {
    const s = fresh("multi");
    const a = createAuditCore({ storage: s });
    const b = createAuditCore({ storage: s });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).record({ tenant: "m", action: "x.tick", actor: { id: String(i) } }),
      ),
    );
    const report = await a.verify("m");
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(10);
  });

  test("two separate PGlite instances do not share data", async () => {
    const a = createPostgresStorage({ client: new PGlite(), table: "shared" });
    const b = createPostgresStorage({ client: new PGlite(), table: "shared" });
    await a.setItem("aud/t/acme/only-in-a", { v: 1 });
    expect(await b.getItem("aud/t/acme/only-in-a")).toBeNull();
    expect(await a.getItem("aud/t/acme/only-in-a")).toEqual({ v: 1 });
  });
});

/** Type/shape checks that need no client connection. */
describe("createPostgresStorage shape", () => {
  test("rejects an unsafe table name", () => {
    expect(() => createPostgresStorage({ client: pglite, table: "bad; DROP TABLE x" })).toThrow(
      /Invalid table name/,
    );
  });

  test("implements the native event log", () => {
    expect(hasEventLog(createPostgresStorage({ client: pglite }))).toBe(true);
  });

  test("close() with a borrowed client is a safe no-op", async () => {
    const s = fresh("borrowed");
    await s.setItem("k", 1);
    await expect(s.close()).resolves.toBeUndefined();
    expect(await s.getItem("k")).toBe(1);
  });
});

/**
 * Optional live-server suite — runs only when `POSTGRES_URL` is set, so CI
 * without a Postgres server simply skips it. Cleans up after itself.
 */
describe.skipIf(!process.env.POSTGRES_URL)("createPostgresStorage (live)", () => {
  const table = `xtandard_audit_test_${Date.now()}`;
  let storage: PostgresAuditStorage;

  beforeAll(() => {
    storage = createPostgresStorage({ connectionString: process.env.POSTGRES_URL, table });
  });

  afterAll(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
    await pool.query(`DROP TABLE IF EXISTS ${table}, ${table}_events, ${table}_event_targets`);
    await pool.end();
    await storage.close();
  });

  test("round-trips an object value", async () => {
    const value = { action: "invoice.paid", count: 42, nested: { x: 1 } };
    await storage.setItem("aud/actions/invoice.paid", value);
    expect(await storage.getItem("aud/actions/invoice.paid")).toEqual(value);
  });

  test("records, queries and verifies through a pg Pool", async () => {
    const audit = createAuditCore({ storage });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        audit.record({ tenant: "live", action: "x.tick", actor: { id: String(i) } }),
      ),
    );
    expect((await audit.query({ tenant: "live", limit: 5 })).items).toHaveLength(5);
    expect((await audit.verify("live")).ok).toBe(true);
  });
});
