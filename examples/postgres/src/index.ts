/**
 * Postgres + Drizzle: the audit log in your app's own database, migrated by
 * drizzle-kit, queried with indexed SQL.
 *
 *   bun run db:up && bun run db:push && bun run start
 *   PGLITE=1 bun run start        # no Docker: in-process Postgres (PGlite), schema pushed here
 *
 * What it does:
 *   1. pays an invoice in YOUR table and records `invoice.paid` through the
 *      audit core (storage: `createDrizzleStorage({ db, ...tables })`);
 *   2. queries the log through the core (families, actor, search) — compiled to
 *      SQL against `xtandard_audit_events` / `xtandard_audit_event_targets`;
 *   3. reads the same rows with plain Drizzle (they are your tables);
 *   4. signs a checkpoint and verifies the chain.
 */
import { desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";
import { createAuditCore, defineActions, ed25519Signer, generateSigningKeyPair } from "@xtandard/audit";
import { createDrizzleStorage } from "@xtandard/audit/storage/drizzle";
import * as schema from "./schema.ts";

const { invoices, auditKv, auditEvents, auditEventTargets } = schema;

// ── The database: node-postgres against docker compose, or PGlite with PGLITE=1 ──
async function connect() {
  if (process.env.PGLITE === "1") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = new PGlite();
    // No `drizzle-kit push` against an in-process database: diff the schema with
    // drizzle-kit's programmatic API instead — the same DDL `db:push` would run.
    // (A variable specifier keeps the repo-wide typecheck from needing drizzle-kit.)
    const kitApi = "drizzle-kit/api";
    const { generateDrizzleJson, generateMigration } = (await import(kitApi)) as {
      generateDrizzleJson(schema: Record<string, unknown>): unknown;
      generateMigration(prev: unknown, cur: unknown): Promise<string[]>;
    };
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema),
    );
    for (const statement of statements) await client.exec(statement);
    return { db: drizzle(client, { schema }), close: () => client.close(), label: "PGlite" };
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://audit:audit@localhost:54329/audit",
  });
  return { db: drizzle(pool, { schema }), close: () => pool.end(), label: "Postgres (pg Pool)" };
}

const { db, close, label } = await connect();

const audit = createAuditCore({
  storage: createDrizzleStorage({
    db,
    table: auditKv,
    events: auditEvents,
    eventTargets: auditEventTargets,
  }),
  actions: defineActions({
    "invoice.paid": {
      group: "Billing",
      targets: ["invoice"],
      metadata: v.object({ amount: v.number(), currency: v.string() }),
    },
    "member.invited": { group: "Members", targets: ["user"] },
  }),
  signer: await ed25519Signer((await generateSigningKeyPair()).privateJwk),
});

// ── 1. A user action: pay an invoice, record it ───────────────────────────────
const invoiceId = `inv_${crypto.randomUUID().slice(0, 8)}`;
const actor = { id: "usr_ada", name: "Ada Lovelace", email: "ada@acme.com" };
await db.insert(invoices).values({
  id: invoiceId,
  orgId: "acme",
  number: "INV-2026-0042",
  amount: 4900,
  currency: "USD",
});
await db.update(invoices).set({ paidAt: new Date() }).where(eq(invoices.id, invoiceId));
await audit.record({
  tenant: "acme",
  action: "invoice.paid",
  actor,
  targets: [{ type: "invoice", id: invoiceId, name: "INV-2026-0042" }],
  metadata: { amount: 4900, currency: "USD" },
  context: { ip: "203.0.113.7", requestId: `req_${crypto.randomUUID().slice(0, 8)}` },
  description: "Ada Lovelace paid INV-2026-0042",
});
await audit.record({
  tenant: "acme",
  action: "member.invited",
  actor,
  targets: [{ type: "user", id: "usr_grace", name: "grace@acme.com" }],
});
console.log(`${label}: paid ${invoiceId} and recorded 2 audit events.\n`);

// ── 2. Query through the core (indexed SQL underneath) ────────────────────────
const billing = await audit.query({ tenant: "acme", actions: ["invoice.*"], limit: 5 });
console.log("invoice.* (newest first):");
for (const e of billing.items) {
  console.log(`  #${e.seq} ${e.occurredAt} ${e.action} ${e.targets.map((t) => `${t.type}:${t.id}`).join(", ")}`);
}
const byTarget = await audit.query({ tenant: "acme", targetType: "invoice", targetId: invoiceId });
console.log(`events touching ${invoiceId}: ${byTarget.items.length}`);
const search = await audit.query({ tenant: "acme", search: "grace" });
console.log(`search "grace": ${search.items.map((e) => e.action).join(", ")}\n`);

// ── 3. They are your tables: plain Drizzle works too ──────────────────────────
const rows = await db
  .select({ seq: auditEvents.seq, action: auditEvents.action, actorId: auditEvents.actorId })
  .from(auditEvents)
  .where(eq(auditEvents.tenant, "acme"))
  .orderBy(desc(auditEvents.seq))
  .limit(3);
console.log("SELECT … FROM xtandard_audit_events (latest 3):", rows);
const [targets] = await db.select({ n: sql<number>`count(*)::int` }).from(auditEventTargets);
console.log(`xtandard_audit_event_targets rows: ${targets?.n}\n`);

// ── 4. Sign the head and verify the chain ─────────────────────────────────────
const checkpoint = await audit.checkpoint("acme");
const report = await audit.verify("acme");
console.log(
  `verify acme: ${report.ok ? "OK" : "BROKEN"} — ${report.checked} events, ` +
    `anchor ${report.anchor}, signed through #${report.signedThrough} (checkpoint ${checkpoint.id})`,
);

await audit.settled();
await close();
process.exit(report.ok ? 0 : 1);
