/**
 * drizzle-audit → @xtandard/audit: row-level changes captured by drizzle-audit
 * land, tenant-scoped and hash-chained, in the log your customers browse and
 * verify.
 *
 *   bun run src/index.ts
 *
 * One in-process Postgres (PGlite) holds both your app's tables and the audit
 * log. drizzle-audit wraps the Drizzle db and captures every insert / update /
 * delete; its storage is `createDrizzleAuditStorage(core, …)`, which maps each
 * entry to an audit event (`db.<table>.<op>`, actor = the context's user,
 * target = the row, metadata = the diff) and commits it through `core.record`.
 * With `onError: "throw"`, a write whose audit event cannot be recorded fails.
 *
 * Then: query the log (by action family, by target row) and verify the chain.
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { withDrizzleAudit, withDrizzleAuditContext } from "drizzle-audit";
import { createAuditCore } from "@xtandard/audit";
import { createDrizzleAuditStorage } from "@xtandard/audit/drizzle-audit";
import { createPostgresStorage } from "@xtandard/audit/storage/postgres";

// ── Your app's schema ─────────────────────────────────────────────────────────
const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  plan: text("plan").notNull(),
  seats: integer("seats").notNull(),
});

const pg = new PGlite();
await pg.exec(`CREATE TABLE projects (
  id SERIAL PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, plan TEXT NOT NULL, seats INTEGER NOT NULL
)`);

// ── The audit core, in the same database (tables created on first use) ──────
const audit = createAuditCore({ storage: createPostgresStorage({ client: pg }) });

// ── drizzle-audit, with the bridge as its storage ────────────────────────────
const db = withDrizzleAudit(drizzle(pg), {
  storage: createDrizzleAuditStorage(audit, {
    // drizzle-audit has no tenant: carry it in the context metadata.
    tenant: (entry) => entry.metadata?.tenantId as string,
  }),
  dataMode: "both", // keep old + new row data alongside the diff
  onError: "throw", // the query fails if its audit event cannot be recorded
});

/**
 * What a request handler does: run the writes inside the user's context. Drizzle
 * queries are lazy — await them INSIDE the callback so they execute in the context.
 */
const asUser = <T>(userId: string, tenantId: string, query: () => PromiseLike<T>) =>
  withDrizzleAuditContext(
    { userId, metadata: { tenantId, ip: "203.0.113.7", requestId: crypto.randomUUID() } },
    async () => await query(),
  );

const [storefront] = await asUser("usr_ada", "acme", () =>
  db.insert(projects).values({ orgId: "acme", name: "storefront", plan: "pro", seats: 5 }).returning(),
);
await asUser("usr_grace", "acme", () =>
  db.update(projects).set({ plan: "enterprise", seats: 25 }).where(eq(projects.id, storefront!.id)),
);
const [portal] = await asUser("usr_hank", "globex", () =>
  db.insert(projects).values({ orgId: "globex", name: "portal", plan: "team", seats: 3 }).returning(),
);
await asUser("usr_hank", "globex", () => db.delete(projects).where(eq(projects.id, portal!.id)));
// Use `.returning()` on inserts: drizzle-audit then awaits the audit write (and knows the row id).
await asUser("usr_ada", "acme", () =>
  db
    .insert(projects)
    .values({ orgId: "acme", name: "data-pipeline", plan: "pro", seats: 5 })
    .returning(),
);

// ── Query the log ─────────────────────────────────────────────────────────────
for (const tenant of ["acme", "globex"]) {
  const page = await audit.query({ tenant, actions: ["db.projects.*"], order: "asc" });
  console.log(`\n${tenant}: ${page.items.length} events from drizzle-audit`);
  for (const e of page.items) {
    const diff = JSON.stringify(e.metadata.changes);
    console.log(`  #${e.seq} ${e.action.padEnd(18)} by ${e.actor.id.padEnd(9)} → ${e.targets.map((t) => `${t.type}:${t.id}`).join(", ")}  ${diff}`);
  }
}
const history = await audit.query({
  tenant: "acme",
  targetType: "projects",
  targetId: String(storefront!.id),
  order: "asc",
});
console.log(`\nHistory of acme projects:${storefront!.id}: ${history.items.map((e) => e.action).join(" → ")}`);

// ── Verify: the bridged events are chained like any other ─────────────────────
for (const tenant of ["acme", "globex"]) {
  const report = await audit.verify(tenant);
  console.log(`verify ${tenant}: ${report.ok ? "OK" : "BROKEN"} (${report.checked} events, anchor ${report.anchor})`);
}

const [{ n } = { n: 0 }] = (
  await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM xtandard_audit_events")
).rows;
console.log(`\nxtandard_audit_events rows in the same PGlite database: ${n}`);
await pg.close();
