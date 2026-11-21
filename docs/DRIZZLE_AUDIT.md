# drizzle-audit

How [`drizzle-audit`](https://github.com/xantiagoma/drizzle-audit) and `@xtandard/audit` fit
together, the bridge between them, and how to migrate an existing drizzle-audit table
([ADR 0009](./ADR/0009-relationship-with-drizzle-audit.md)).

## Capture layer vs control plane

|           | `drizzle-audit`                                              | `@xtandard/audit`                                                         |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Answers   | _what changed in which row_                                  | _who did what to which resource, in which tenant — provably_              |
| Captures  | Drizzle insert / update / delete diffs, `trackAction`        | business actions you `record()` (and, via the bridge, drizzle-audit rows) |
| Unit      | `AuditEntry` (table, row id, changes, old/new data, user id) | `AuditEvent` (tenant, actor, action, targets, context, metadata)          |
| Integrity | —                                                            | per-tenant hash chain, signed checkpoints, verifiable exports             |
| Audience  | engineers, debugging, data forensics                         | your customers (viewer/portal), auditors, SIEMs                           |
| Ships     | context, transforms, sampling, middleware, storages          | storage drivers, query, viewer, export, verify, retention, streaming      |

They are separate packages with **no dependency in either direction**. Use drizzle-audit alone
for internal change history; use `@xtandard/audit` alone for a customer-facing log of business
actions; use both, bridged, when DB-level changes should also land — tenant-scoped and
tamper-evident — in the log your customers browse and verify.

## The bridge

`@xtandard/audit/drizzle-audit` exports `createDrizzleAuditStorage(core, options)`: an object that
structurally satisfies drizzle-audit's `AuditStorage` (`write`, `flush`, `close`). Plug it in as
the storage:

```ts
import { withDrizzleAudit, withDrizzleAuditContext } from "drizzle-audit";
import { createDrizzleAuditStorage } from "@xtandard/audit/drizzle-audit";

const db = withDrizzleAudit(rawDb, {
  storage: createDrizzleAuditStorage(audit, {
    tenant: (entry) => entry.metadata?.tenantId as string,
  }),
  dataMode: "both",
  onError: "throw", // the query fails when the audit event cannot be recorded
});

await withDrizzleAuditContext(
  { userId: "user_1", metadata: { tenantId: "acme", ip: "203.0.113.7", requestId: "req_1" } },
  () => db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, 42)).returning(),
);
// → audit event "db.invoices.update" in tenant "acme", actor user_1, target invoices:42
```

Keep drizzle-audit's transforms (`redact`, `mask`, …) for row data — they run before the bridge
sees the entry — and the core's `transforms` for the final event.

### Mapping

| Event field  | Default                                                                                                                                                                                                                  | Override                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `tenant`     | the `tenant` option (a key or `(entry) => key`), else `entry.tenantId`, else `entry.metadata.tenantId`, else the ambient audit context's tenant                                                                          | `tenant` (optional)     |
| `action`     | `db.<table>.<insert\|update\|delete>`, lower-cased (unsupported characters → `_`); custom actions keep their name                                                                                                        | `action: (entry) => …`  |
| `actor`      | `{ id: userId, type: "user" }`, else the ambient context's actor, else `{ id: "system", type: "system" }`                                                                                                                | `actor: (entry) => …`   |
| `targets`    | `[{ type: tableName, id: rowId }]` (none without both)                                                                                                                                                                   | `targets: (entry) => …` |
| `occurredAt` | the entry's `timestamp`                                                                                                                                                                                                  | —                       |
| `context`    | `ip`, `userAgent`, `requestId` from `entry.metadata` (string values)                                                                                                                                                     | —                       |
| `metadata`   | `{ changes, oldData, newData, extra? }` — `extra` = the rest of `entry.metadata`                                                                                                                                         | —                       |
| `id`         | deterministic: the entry timestamp (48 bits) + 80 bits of SHA-256 over the entry's content (table, action, row id, user, changes, old/new data, metadata) — not `entry.id`, which `drizzleTableStorage` does not persist | —                       |

`include: (entry) => boolean` forwards only matching entries. Values are made JSON-safe (Dates →
ISO strings, bigints → strings, `undefined` dropped).

Because ids are deterministic, writing the same entry twice is a no-op (same id + same content);
the same id with different content throws `ConflictError`.

### Strict or buffered

By default `write` commits synchronously through `core.recordMany` — failures reach drizzle-audit's
`onError` (`"throw"` makes the DB operation fail with its audit event; `"warn"` logs and moves on).
For hot paths, pass a buffered recorder ([ADR 0002](./ADR/0002-record-path-never-loses-events.md)):
`write` enqueues and returns, `flush()` / `close()` drain it.

```ts
import { createRecorder } from "@xtandard/audit";
import { fileFallback } from "@xtandard/audit/sinks/file";

const recorder = createRecorder(audit, { fallback: fileFallback("./audit-fallback.jsonl") });
const storage = createDrizzleAuditStorage(audit, {
  tenant: (e) => e.metadata?.tenantId as string,
  recorder,
});
```

### Tenancy

drizzle-audit releases after 0.1.13 carry a first-class `tenantId` on the context and the entry; the
bridge uses it by default. On 0.1.13, put the tenant in the context metadata
(`withDrizzleAuditContext({ userId, metadata: { tenantId } }, …)`) — the bridge reads
`metadata.tenantId` as a fallback — or run
the request inside an `@xtandard/audit` context (`auditContext` middleware / `runWithAuditContext`)
and let the bridge fall back to its tenant and actor.

## Migration: importing an existing table

Rows written by `drizzleTableStorage` (or any store of `AuditEntry`-shaped rows) can be imported
into the chain with `importDrizzleAuditEntries(core, rows, mapping)`:

```ts
import { importDrizzleAuditEntries } from "@xtandard/audit/drizzle-audit";

const rows = await db.select().from(auditLog); // or page through it
const events = await importDrizzleAuditEntries(audit, rows, {
  tenant: (row) => (row.metadata?.tenantId as string) ?? "legacy",
  include: (row) => row.tableName !== "sessions",
  batchSize: 500,
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
```

- Rows are **sorted by timestamp** (then id) and chained in that order, with `occurredAt` = the row
  timestamp; `recordedAt` is the import time (the chain records when the log accepted them).
- Same mapping options as the bridge (`tenant`, `action`, `actor`, `targets`, `include`).
- **Idempotent**: re-running an import (after a crash, or with overlapping pages) skips rows
  already imported, thanks to the deterministic, content-derived ids — as long as the mapping is unchanged
  and the database keeps millisecond timestamps. A change forwarded live and later imported from the table
  maps to the same event. Newer drizzle-audit exports `toAuditEntry(row)` to normalize stored rows from any
  driver (Date timestamps, JSON-as-text, snake_case) before importing.
- Import into a fresh tenant (or before live events) to keep `seq` order equal to time order;
  importing history after newer events works, but those rows chain after them.
- `timestamp` may be a `Date`, an ISO string or epoch millis (whatever your driver returns).

Cut over by switching the drizzle-audit storage to the bridge (or to `multiStorage` with both
during a transition), then import the table up to the cutover point.
