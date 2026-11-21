# postgres × @xtandard/audit

The audit log in **your app's own Postgres**, as Drizzle tables in your schema,
migrated by drizzle-kit like any other table, queried with indexed SQL.

```ts
// src/schema.ts — next to your tables
import { pgAuditTables } from "@xtandard/audit/drizzle/pg";
export const {
  table: auditKv,
  events: auditEvents,
  eventTargets: auditEventTargets,
} = pgAuditTables(); // xtandard_audit, xtandard_audit_events, xtandard_audit_event_targets

// wherever you build the core
import { createDrizzleStorage } from "@xtandard/audit/storage/drizzle";
const storage = createDrizzleStorage({
  db,
  table: auditKv,
  events: auditEvents,
  eventTargets: auditEventTargets,
});
```

The Drizzle adapter issues no DDL and owns no connection. The tables match what
`createPostgresStorage` creates, so a database can move between the raw driver
and Drizzle.

## What's here

- **`docker-compose.yml`** — `postgres:16` on host port **54329**.
- **`drizzle.config.ts`** — drizzle-kit pointed at `src/schema.ts`.
- **`src/schema.ts`** — an app table (`invoices`) + `pgAuditTables()`.
- **`src/index.ts`** — pays an invoice in your table and records `invoice.paid`;
  queries the log through the core (family, target, search); reads the same rows
  with plain Drizzle; signs a checkpoint and verifies the chain.

## Run it

```bash
bun install
bun run db:up              # docker compose up -d --wait
bun run db:push            # drizzle-kit creates invoices + the three audit tables
bun run start
# bun run db:generate      # or: write SQL migrations to ./drizzle instead of pushing
docker compose down -v     # when done

PGLITE=1 bun run start     # no Docker: in-process Postgres; the schema is diffed with drizzle-kit's API
```

Set `DATABASE_URL` to use another database. Checkpoints only verify against the
key that signed them, so the example signs with `AUDIT_SIGNING_KEY` when set
(`xtandard-audit keygen`), else with a key it generates once into
`./.audit/signing-key.json` — re-runs keep verifying.

## Files

- [`src/schema.ts`](./src/schema.ts) — your schema with the audit tables in it.
- [`src/index.ts`](./src/index.ts) — record, query (core + plain Drizzle), checkpoint, verify.
- [`drizzle.config.ts`](./drizzle.config.ts), [`docker-compose.yml`](./docker-compose.yml).
