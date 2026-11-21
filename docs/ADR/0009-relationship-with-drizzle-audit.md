# ADR 0009 — Relationship with `drizzle-audit`: Capture Layer vs Control Plane

**Status:** Accepted

---

## Context

`drizzle-audit` (0.1.13, same author) captures **row-level database changes** made through Drizzle
(insert/update/delete diffs, `trackAction` for custom actions), with an AsyncLocalStorage context,
transforms (redact/mask/hash/omit), sampling, framework middleware, and sinks (`drizzleTableStorage`,
`httpStorage`, `consoleStorage`, `multiStorage`, `callbackStorage`) behind a one-method
`AuditStorage { write(entries) }` interface.

`@xtandard/audit` is a different layer: the **customer-facing, tenant-scoped, tamper-evident log of
business actions** — storage drivers, query, viewer, export, verification, streaming.

## Decision

1. They stay **separate packages with no dependency in either direction**. `drizzle-audit` is a
   capture layer (what changed in which row); `@xtandard/audit` is a control plane (who did what to
   which resource in which tenant, provably).
2. `@xtandard/audit/drizzle-audit` ships a **bridge**: `createDrizzleAuditStorage(core, { tenant,
   action, actor, include })` returns an object that structurally satisfies drizzle-audit's
   `AuditStorage`, mapping each `AuditEntry` to an audit event (`action` = `db.<table>.<op>` or the
   custom action, `targets` = `[{ type: table, id: rowId }]`, `actor.id` = `userId`,
   `metadata` = `{ changes, oldData, newData }`). Typed structurally, so drizzle-audit is not a peer.
3. Reused ideas (re-implemented, not imported): transform helpers (`redact`, `mask`, `hash`,
   `omit`), the AsyncLocalStorage context pattern (ADR 0013), the batching HTTP sink design.
4. **Migration path**: existing `drizzle-audit` tables can be imported with
   `importDrizzleAuditEntries(core, rows, mapping)` (chained in `occurredAt` order).
5. Proposed (not applied — the repo is not ours to modify here) improvements for drizzle-audit are
   sent to the coordinator: a first-class `tenantId` in the context, and a documented "send to
   @xtandard/audit" recipe in its README.

## Consequences

- Teams can capture DB-level diffs with drizzle-audit and still give customers a verified,
  browsable log, without either library growing into the other.
