/**
 * The app's Drizzle schema: its own table(s) plus the three audit tables.
 *
 * `pgAuditTables()` returns `{ table, events, eventTargets }` — the KV table
 * (catalog, checkpoints, chain heads, stream cursors) and the native event log
 * (indexed columns for every query filter). Export each one so drizzle-kit
 * sees it; the names match what `createPostgresStorage` would create, so a
 * database can move between the raw driver and Drizzle.
 */
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { pgAuditTables } from "@xtandard/audit/drizzle/pg";

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  number: text("number").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

// xtandard_audit, xtandard_audit_events, xtandard_audit_event_targets
export const {
  table: auditKv,
  events: auditEvents,
  eventTargets: auditEventTargets,
} = pgAuditTables();
