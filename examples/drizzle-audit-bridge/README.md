# drizzle-audit-bridge × @xtandard/audit

[drizzle-audit](https://github.com/xantiagoma/drizzle-audit) captures **row
changes** (insert / update / delete diffs); `@xtandard/audit` is the
**tenant-facing, tamper-evident log**. The bridge plugs one into the other, so
DB-level changes land — tenant-scoped and hash-chained — in the log your
customers browse and verify.

```ts
import { withDrizzleAudit, withDrizzleAuditContext } from "drizzle-audit";
import { createDrizzleAuditStorage } from "@xtandard/audit/drizzle-audit";

const db = withDrizzleAudit(rawDb, {
  storage: createDrizzleAuditStorage(audit, {
    tenant: (entry) => entry.metadata?.tenantId as string,
  }),
  dataMode: "both",
  onError: "throw", // the query fails when its audit event cannot be recorded
});
```

## What's here

One in-process Postgres (PGlite) holds your `projects` table **and** the audit
log (`createPostgresStorage({ client: pglite })`). Three users in two tenants
insert, update and delete projects inside `withDrizzleAuditContext({ userId,
metadata: { tenantId, ip, requestId } })`. Each change becomes an event:

| Event field | From the drizzle-audit entry                                        |
| ----------- | ------------------------------------------------------------------- |
| `action`    | `db.projects.insert` / `.update` / `.delete`                        |
| `tenant`    | the bridge's `tenant` option (here: `metadata.tenantId`)            |
| `actor`     | `userId`                                                            |
| `targets`   | `[{ type: "projects", id: rowId }]`                                 |
| `metadata`  | `{ entryId, changes, oldData, newData }`                            |
| `id`        | deterministic from the entry — re-writing the same entry is a no-op |

Then it queries the log (`db.projects.*` per tenant, one row's history by
target) and verifies both chains.

## Run it

```bash
bun install
bun run start
```

```txt
acme: 3 events from drizzle-audit
  #1 db.projects.insert by usr_ada   → projects:1  {"id":1,"name":"storefront",…}
  #2 db.projects.update by usr_grace → projects:1  {"plan":{"to":"enterprise","from":"pro"},"seats":{"to":25,"from":5}}
  …
History of acme projects:1: db.projects.insert → db.projects.update
verify acme: OK (3 events, anchor genesis)
```

Use `.returning()` on audited inserts: drizzle-audit then awaits the audit write
(so `onError: "throw"` can fail the query) and knows the row id. For hot paths,
pass a buffered `createRecorder()` as the bridge's `recorder`; to move an
existing drizzle-audit table into the chain, use `importDrizzleAuditEntries` —
see [drizzle-audit](../../docs/DRIZZLE_AUDIT.md).

## Files

- [`src/index.ts`](./src/index.ts) — the schema, the bridge, the writes, the queries and the verification.
