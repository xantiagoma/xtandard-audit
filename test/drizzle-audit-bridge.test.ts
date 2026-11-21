import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import {
  trackAction,
  withDrizzleAudit,
  withDrizzleAuditContext,
  type AuditStorage,
} from "drizzle-audit";
import { pgAuditTable } from "drizzle-audit/pg";
import { drizzleTableStorage } from "drizzle-audit/storage/drizzle";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDrizzleAuditStorage,
  defaultDrizzleAuditAction,
  drizzleAuditEntryToInput,
  drizzleAuditEventId,
  importDrizzleAuditEntries,
  type DrizzleAuditEntry,
} from "../src/bridges/drizzle-audit.ts";
import { runWithAuditContext } from "../src/context.ts";
import { createAuditCore } from "../src/core.ts";
import { createRecorder } from "../src/recorder.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});
const auditLog = pgAuditTable();

// One PGlite per file (its WASM boot is the slow part); tables are recreated per test.
let pg: PGlite | null = null;
async function makeDb() {
  pg ??= new PGlite();
  const db = drizzle(pg);
  await db.execute(sql`DROP TABLE IF EXISTS users, audit_log`);
  await db.execute(sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
  await db.execute(sql`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, table_name TEXT, action VARCHAR(50) NOT NULL, row_id TEXT,
      changes JSONB, old_data JSONB, new_data JSONB, user_id TEXT, metadata JSONB,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  return db;
}
afterAll(async () => {
  await pg?.close();
});

const makeCore = () => createAuditCore({ storage: createMemoryStorage(), selfAudit: false });

const entry = (over: Partial<DrizzleAuditEntry> = {}): DrizzleAuditEntry => ({
  id: "0190a0b0-0000-7000-8000-000000000001",
  tableName: "users",
  action: "INSERT",
  rowId: "1",
  changes: { name: "Ada" },
  oldData: null,
  newData: null,
  timestamp: new Date("2026-01-02T03:04:05.678Z"),
  userId: "user_1",
  metadata: null,
  ...over,
});

describe("createDrizzleAuditStorage with real drizzle-audit", { timeout: 60_000 }, () => {
  it("records insert / update / delete as chained audit events", async () => {
    const core = makeCore();
    const storage = createDrizzleAuditStorage(core, {
      tenant: (e) => e.metadata?.tenantId as string,
    });
    // Compile-time check: the bridge satisfies drizzle-audit's AuditStorage.
    const asDrizzle: AuditStorage = storage;
    const db = withDrizzleAudit(await makeDb(), {
      storage: asDrizzle,
      onError: "throw",
      dataMode: "both",
    });

    await withDrizzleAuditContext(
      {
        userId: "user_1",
        metadata: { tenantId: "acme", ip: "10.0.0.1", requestId: "req_1", plan: "pro" },
      },
      async () => {
        await db.insert(users).values({ name: "Ada" }).returning();
        await db.update(users).set({ name: "Grace" }).where(eq(users.id, 1)).returning();
        await db.delete(users).where(eq(users.id, 1)).returning();
      },
    );

    const page = await core.query({ tenant: "acme", order: "asc" });
    expect(page.items.map((e) => e.action)).toEqual([
      "db.users.insert",
      "db.users.update",
      "db.users.delete",
    ]);
    const [ins, upd] = page.items;
    expect(ins!.actor).toEqual({ id: "user_1", type: "user" });
    expect(ins!.targets).toEqual([{ type: "users", id: "1" }]);
    expect(ins!.context).toEqual({ ip: "10.0.0.1", requestId: "req_1" });
    expect(ins!.metadata).toMatchObject({
      changes: { id: 1, name: "Ada" },
      extra: { tenantId: "acme", plan: "pro" },
    });
    expect(ins!.metadata).not.toHaveProperty("entryId");
    expect(upd!.metadata).toMatchObject({
      changes: { name: { from: "Ada", to: "Grace" } },
      oldData: { id: 1, name: "Ada" },
      newData: { id: 1, name: "Grace" },
    });
    expect((await core.verify("acme")).ok).toBe(true);
    await storage.flush();
    await storage.close();
  });

  it("custom actions (trackAction) keep their name; system actor without a user", async () => {
    const core = makeCore();
    const storage = createDrizzleAuditStorage(core, { tenant: "acme" });
    withDrizzleAudit(await makeDb(), { storage, onError: "throw" });
    {
      await using tracker = trackAction({ action: "report.generate", metadata: { format: "pdf" } });
      tracker.addMetadata({ rows: 3 });
    }
    const page = await core.query({ tenant: "acme", order: "asc" });
    expect(page.items.length).toBeGreaterThan(0);
    for (const e of page.items) {
      expect(e.action.startsWith("report.generate")).toBe(true);
      expect(e.actor).toEqual({ id: "system", type: "system" });
      expect(e.targets).toEqual([]);
    }
  });

  it("drizzle-audit's onError sees core failures (synchronous commit)", async () => {
    const core = makeCore();
    const db = withDrizzleAudit(await makeDb(), {
      storage: createDrizzleAuditStorage(core, { tenant: () => null }),
      onError: "throw",
    });
    await expect(db.insert(users).values({ name: "Ada" }).returning()).rejects.toThrow("no tenant");
  });

  it("buffered mode goes through a recorder; flush drains it", async () => {
    const core = makeCore();
    const recorder = createRecorder(core, { flushIntervalMs: 60_000 });
    const storage = createDrizzleAuditStorage(core, { tenant: "acme", recorder });
    await storage.write([entry()]);
    expect(recorder.pending).toBe(1);
    await storage.flush();
    expect(recorder.pending).toBe(0);
    expect(await core.count("acme")).toBe(1);
    await storage.write([entry({ id: "e2", rowId: "2" })]);
    await storage.close();
    expect(await core.count("acme")).toBe(2);
    await recorder.close();
  });
});

describe("mapping", () => {
  it("default actions: CRUD lower-cased per table, custom names kept or sanitized", () => {
    expect(
      defaultDrizzleAuditAction(entry({ tableName: "Billing Invoices", action: "UPDATE" })),
    ).toBe("db.billing_invoices.update");
    expect(defaultDrizzleAuditAction(entry({ tableName: null, action: "export.run" }))).toBe(
      "export.run",
    );
    expect(defaultDrizzleAuditAction(entry({ tableName: "users", action: "user.invited" }))).toBe(
      "user.invited",
    );
    expect(defaultDrizzleAuditAction(entry({ tableName: null, action: "  weird action!" }))).toBe(
      "weird_action_",
    );
    expect(defaultDrizzleAuditAction(entry({ tableName: null, action: "!!!" }))).toBe("custom");
  });

  it("tenant resolution: option, entry.tenantId, metadata.tenantId, ambient", async () => {
    const base = entry({ tenantId: "from-entry", metadata: { tenantId: "from-meta" } });
    expect((await drizzleAuditEntryToInput(base, { tenant: "opt" }))!.tenant).toBe("opt");
    expect((await drizzleAuditEntryToInput(base, {}))!.tenant).toBe("from-entry");
    expect(
      (await drizzleAuditEntryToInput(entry({ metadata: { tenantId: "from-meta" } }), {}))!.tenant,
    ).toBe("from-meta");
    await expect(drizzleAuditEntryToInput(entry({ metadata: null }), {})).rejects.toThrow(
      "no tenant",
    );
  });

  it("a live entry and its stored row (new id) map to the same event id", async () => {
    const live = entry({ id: "live-uuid" });
    const stored = { ...live, id: 42, timestamp: new Date(live.timestamp as string).toISOString() };
    expect(await drizzleAuditEventId(stored)).toBe(await drizzleAuditEventId(live));
  });

  it("event ids are deterministic and time-sortable", async () => {
    const a = await drizzleAuditEventId(entry());
    expect(a).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await drizzleAuditEventId(entry())).toBe(a);
    // Content-derived: drizzleTableStorage does not keep entry.id, so it is not part of the id.
    expect(await drizzleAuditEventId(entry({ id: "other" }))).toBe(a);
    expect(await drizzleAuditEventId(entry({ rowId: "other" }))).not.toBe(a);
    const later = await drizzleAuditEventId(entry({ timestamp: "2026-01-02T03:04:06.000Z" }));
    expect(later > a).toBe(true);
    await expect(drizzleAuditEventId(entry({ timestamp: "nope" }))).rejects.toThrow(
      "invalid timestamp",
    );
  });

  it("overrides, include filter, ambient context fallbacks, JSON-safe values", async () => {
    expect(
      await drizzleAuditEntryToInput(entry(), { tenant: "acme", include: () => false }),
    ).toBeNull();
    const custom = await drizzleAuditEntryToInput(entry(), {
      tenant: "acme",
      action: () => "user.created",
      actor: (e) => ({ id: `u:${e.userId}`, type: "admin" }),
      targets: () => [{ type: "user", id: "42" }],
    });
    expect(custom).toMatchObject({
      action: "user.created",
      actor: { id: "u:user_1", type: "admin" },
      targets: [{ type: "user", id: "42" }],
    });

    const ambient = await runWithAuditContext(
      { tenant: "globex", actor: { id: "svc", type: "service" } },
      () =>
        drizzleAuditEntryToInput(entry({ userId: null, rowId: null }), { tenant: () => undefined }),
    );
    expect(ambient).toMatchObject({ tenant: "globex", actor: { id: "svc" }, targets: [] });

    const odd = await drizzleAuditEntryToInput(
      entry({
        id: 7,
        changes: {
          big: 10n as unknown as number,
          at: new Date("2026-01-01T00:00:00Z"),
          gone: undefined,
        },
        metadata: { userAgent: "UA", ip: 42, nested: { a: 1 } },
      }),
      { tenant: "acme" },
    );
    expect(odd!.metadata).toEqual({
      changes: { big: "10", at: "2026-01-01T00:00:00.000Z" },
      oldData: null,
      newData: null,
      extra: { ip: 42, nested: { a: 1 } },
    });
    expect(odd!.context).toEqual({ userAgent: "UA" });
  });
});

describe("importDrizzleAuditEntries", { timeout: 60_000 }, () => {
  it("imports drizzleTableStorage rows in timestamp order, idempotently", async () => {
    const raw = await makeDb();
    const db = withDrizzleAudit(raw, {
      storage: drizzleTableStorage(auditLog, { db: raw }),
      auditTable: auditLog,
    });
    await withDrizzleAuditContext(
      { userId: "user_1", metadata: { tenantId: "acme" } },
      async () => {
        await db.insert(users).values({ name: "Ada" }).returning();
        await db.insert(users).values({ name: "Grace" }).returning();
        await db.update(users).set({ name: "Ada L." }).where(eq(users.id, 1)).returning();
      },
    );
    const rows = (await raw.select().from(auditLog)) as DrizzleAuditEntry[];
    expect(rows).toHaveLength(3);

    const core = makeCore();
    const progress: number[] = [];
    const mapping = {
      tenant: (r: DrizzleAuditEntry) => (r.metadata?.tenantId as string) ?? "legacy",
      batchSize: 2,
      onProgress: (n: number) => progress.push(n),
    };
    const events = await importDrizzleAuditEntries(core, [...rows].reverse(), mapping);
    expect(progress).toEqual([2, 3]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const times = events.map((e) => e.occurredAt);
    expect([...times].sort()).toEqual(times);
    expect(events.map((e) => e.occurredAt)).toEqual(
      [...rows]
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .map((r) => new Date(r.timestamp).toISOString()),
    );
    expect((await core.verify("acme")).ok).toBe(true);

    // Re-running the import is a no-op (deterministic ids, same content).
    const again = await importDrizzleAuditEntries(core, rows, mapping);
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(await core.count("acme")).toBe(3);
  });

  it("orders same-timestamp rows by id and skips excluded rows", async () => {
    const core = makeCore();
    const t = "2026-01-01T00:00:00.000Z";
    const events = await importDrizzleAuditEntries(
      core,
      [
        entry({ id: "b", rowId: "2", timestamp: t }),
        entry({ id: "a", rowId: "1", timestamp: t }),
        entry({ id: "c", rowId: "3", timestamp: t }),
      ],
      { tenant: "acme", include: (r) => r.id !== "c" },
    );
    expect(events.map((e) => e.targets[0]?.id)).toEqual(["1", "2"]);
  });
});
