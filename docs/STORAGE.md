# Storage

Bring your own backend: the whole system runs on a four-method async KV contract, with optional capabilities feature-detected at runtime. Backends with indexes add one audit-specific capability — the **native event log** — so queries run in the database instead of over KV scans ([ADR 0005](./ADR/0005-storage-kv-contract-event-log-capability.md)).

## The contract

```ts
interface AuditStorage {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
  getKeys(prefix: string): Promise<string[]>;
}
```

Optional capabilities (separate interfaces + guards exported from `@xtandard/audit`): `watch` (change notifications), `compareAndSwap` (multi-writer safety for the KV fallback), and the audit-specific **`EventLogStorage`** (`hasEventLog`). `TransactionalAuditStorage` / `isTransactional` stay exported for compatibility; no driver implements them.

The KV contract, its capabilities and every driver's KV side are [`@xtandard/kit`](https://github.com/xantiagoma/xtandard-kit)'s storage; audit passes its persisted names (table `xtandard_audit`, Mongo `xtandard_audit` / `audit_kv`, channel `xtandard_audit`) and keeps the event log on top of the kit's driver internals (the shared connection, its DDL and its SQL executor).

Control data — the action catalog, per-tenant chain heads, checkpoints, stream cursors and leases — **always** lives in KV keys. Events live in the native event log when the storage has one, and in KV keys otherwise.

## The native event log

```ts
interface EventLogStorage extends AuditStorage {
  appendEvents(
    tenant: string,
    events: AuditEvent[],
    options: { expectedSeq: number },
  ): Promise<void>;
  getEvent(tenant: string, id: string): Promise<AuditEvent | null>;
  lastEvent(tenant: string): Promise<AuditEvent | null>;
  eventsBySeq(tenant: string, options: { afterSeq: number; limit: number }): Promise<AuditEvent[]>;
  queryEvents(query: NormalizedQuery): Promise<{ items: AuditEvent[]; hasMore: boolean }>;
  replaceEvent(event: AuditEvent): Promise<void>; // erasure
  deleteEventsThrough(tenant: string, throughSeq: number): Promise<number>; // retention
  countEvents(tenant?: string): Promise<number>;
  listEventTenants(): Promise<string[]>;
}
```

The semantics that matter:

- **`appendEvents` is atomic.** Either the whole batch is stored or none of it. It throws `ChainConflictError` when the tenant's last stored seq is not `expectedSeq` or when a `(tenant, seq)` / `(tenant, id)` already exists — the core then re-reads the head, re-chains the batch and retries ([ADR 0004](./ADR/0004-tamper-evidence-hash-chain-checkpoints.md) §7). A tenant with no rows at all (fresh, or fully pruned) accepts any `expectedSeq`: the KV chain head is the authority there.
- **`queryEvents` agrees exactly with the in-memory matcher** (`matchesQuery` in `src/query.ts`): every filter, sorted by `(occurredAt, id)` in `query.order`, strictly after `query.after`, at most `query.limit` items. Action families (`invoice.*`) and `search` are case-sensitive prefix / lower-cased substring matches; `actorType` treats a missing type as `"user"`; target filters match when **one** target has both the type and the id.
- Reads return the event exactly as stored; `replaceEvent` rewrites one event in place (same tenant/seq/id).

### SQL layout

The SQL drivers (`postgres`, `sqlite`, `libsql`, `drizzle`) share one layout next to the KV table `{table}` (default `xtandard_audit`):

```txt
{table}_events          tenant, seq, id, action, occurred_at, recorded_at, actor_id, actor_type,
                        outcome, search, data
                        PRIMARY KEY (tenant, seq), UNIQUE (tenant, id)
                        INDEX (tenant, occurred_at, id)
                        INDEX (tenant, actor_id, occurred_at, id)
                        INDEX (tenant, action, occurred_at, id)
{table}_event_targets   tenant, seq, type, target_id         -- one row per distinct target
                        INDEX (tenant, type, target_id, seq), INDEX (tenant, seq)
```

- `data` is the full event (`jsonb` / `json` / JSON text) and is what reads return; the other columns are denormalized for filtering and ordering.
- `occurred_at` is the event's ISO-8601 UTC string (millisecond precision, `Z`), so it sorts lexicographically. Postgres stores `id`, `action` and `occurred_at` with `COLLATE "C"`; MySQL uses `utf8mb4_bin` for every key/filter column — bytewise ordering and case-sensitive matching whatever the database default, so SQL agrees with the in-memory matcher.
- `actor_type` holds the effective type (`"user"` when the event has none); `search` is `searchText(event)` (action, actor, targets, description and metadata JSON, lower-cased).
- A query compiles to one `SELECT data … WHERE … ORDER BY occurred_at, id LIMIT limit + 1` with keyset pagination `(occurred_at < ? OR (occurred_at = ? AND id < ?))` (flipped for `asc`), target filters as `EXISTS` over `{table}_event_targets`, and LIKE/GLOB patterns with escaped wildcards.
- Queries without a tenant span all tenants.

## Adapters

| Subpath                                           | Factory                                                  | Peers            | watch                              | CAS            | native event log      |
| ------------------------------------------------- | -------------------------------------------------------- | ---------------- | ---------------------------------- | -------------- | --------------------- |
| `storage/memory`                                  | `createMemoryStorage`                                    | —                | ✓                                  | ✓              | ✓                     |
| `storage/postgres`                                | `createPostgresStorage`                                  | `pg`             | via `withWatch` + `pgListenNotify` | ✓              | ✓                     |
| `storage/sqlite`                                  | `createSqliteStorage`                                    | — (`bun:sqlite`) | via `withWatch`                    | ✓              | ✓                     |
| `storage/libsql`                                  | `createLibsqlStorage`                                    | `@libsql/client` | via `withWatch`                    | ✓              | ✓                     |
| `storage/drizzle`                                 | `createDrizzleStorage`                                   | `drizzle-orm`    | via `withWatch`                    | ✓              | ✓ (with event tables) |
| `drizzle/pg` / `drizzle/mysql` / `drizzle/sqlite` | `pgAuditTables`, `pgAuditTable`, `pgAuditEventsTable`, … | `drizzle-orm`    |                                    |                | (schema)              |
| `storage/mongodb`                                 | `createMongoStorage`                                     | `mongodb`        | via `withWatch`                    | ✓              | ✓                     |
| `storage/file`                                    | `createFileStorage`                                      | —                | ✓ (`fs.watch`)                     | ✓ (in-process) | KV fallback           |
| `storage/redis`                                   | `createRedisStorage`, `createRedisJSONStorage`           | `redis`          | ✓ (keyspace notifications)         | ✓              | KV fallback           |
| `storage/unstorage`                               | `createUnstorageStorage`                                 | `unstorage`      | via `withWatch`                    |                | KV fallback           |
| `storage/cloudflare-kv`                           | `createCloudflareKvStorage`                              | — (binding)      | via `withWatch`                    |                | KV fallback           |

Conventions shared by every adapter (the kit's): borrowed clients are never closed; optional peers load via a lazy dynamic `import()` with an actionable error naming the `@xtandard/audit/storage/<driver>` subpath; `close()` exists only on owning adapters; custom table names are validated as safe SQL identifiers (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`); a failed connect or DDL is retried on the next call, not cached. KV values are written as canonical JSON (sorted keys), `getKeys` matches the prefix literally (escaped `LIKE`/`GLOB`/`MATCH`, plus an exact `startsWith`), and values written by earlier releases read back and swap unchanged.

### Postgres

```ts
import { createPostgresStorage } from "@xtandard/audit/storage/postgres";

const storage = createPostgresStorage({ connectionString: process.env.DATABASE_URL });
// or a pg Pool / Client / PGlite you own: createPostgresStorage({ client: pool })
```

Creates its three tables on first use (`CREATE TABLE IF NOT EXISTS`); a new KV table gets `key text COLLATE "C"`, an existing one keeps working as is. Every event-log write is a **single statement** (data-modifying CTEs) — atomic without an explicit transaction, so it is correct on a `pg` `Pool` where consecutive queries may land on different connections.

### SQLite (Bun) and libSQL / Turso

```ts
import { createSqliteStorage } from "@xtandard/audit/storage/sqlite";
const storage = createSqliteStorage({ path: "./audit.sqlite" });

import { createLibsqlStorage } from "@xtandard/audit/storage/libsql";
const storage = createLibsqlStorage({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

Both create their tables on first use (`bun:sqlite` is loaded then too, so importing `storage/sqlite` works under Node). Both share one SQLite-dialect event log: appends, erasure rewrites and prunes are a few statements run atomically — a `BEGIN IMMEDIATE` transaction on `bun:sqlite`, one `batch(…, "write")` round-trip on libSQL. Action families use `GLOB` (SQLite's `LIKE` ignores ASCII case).

### Drizzle

The Drizzle adapter issues **no DDL** and owns no connection: put the tables in your schema and let `drizzle-kit` migrate them.

```ts
// schema.ts — export each table so drizzle-kit picks it up
import { pgAuditTables } from "@xtandard/audit/drizzle/pg"; // or mysqlAuditTables / sqliteAuditTables
export const {
  table: auditKv,
  events: auditEvents,
  eventTargets: auditEventTargets,
} = pgAuditTables(); // xtandard_audit, xtandard_audit_events, xtandard_audit_event_targets

// audit.ts
import { createDrizzleStorage } from "@xtandard/audit/storage/drizzle";
const storage = createDrizzleStorage({
  db,
  table: auditKv,
  events: auditEvents,
  eventTargets: auditEventTargets,
});
```

The per-table factories (`pgAuditTable` for KV — same options as the webhooks/flags factory — plus `pgAuditEventsTable`, `pgAuditEventTargetsTable`, and the MySQL/SQLite equivalents) exist when you want different names. `pgAuditTables(name, { schema })` places all three in a Postgres schema. Omitting `events`/`eventTargets` gives a KV-only storage (the core then uses its generic KV event log).

Writes use `db.transaction` (async on Postgres, MySQL and libSQL; a synchronous `immediate` transaction on `bun:sqlite` / `better-sqlite3`). The columns match the raw drivers' tables, so a database can move between `createPostgresStorage`/`createSqliteStorage` and Drizzle. The dialect is read from `db` (or pass `dialect`), and `drizzle-orm` is loaded on first use.

**MySQL keys and trailing spaces.** The KV key column is `utf8mb4_bin`, a PAD SPACE collation: `"a "` and `"a"` are the same primary key. The driver matches keys byte-exactly and refuses a write whose key differs from a stored one only by trailing spaces (`KeyCollisionError`, exported from `@xtandard/audit/storage/drizzle`). Audit keys never end in a space (every free-form segment is URI-encoded), and the HTTP API answers 404 for a padded tenant or event id. New tables can use a NO PAD collation: `mysqlAuditTable(name, { keyCollation: "utf8mb4_0900_bin" })` (MySQL 8.0+; `utf8mb4_nopad_bin` on MariaDB). To migrate an existing table:

```sql
ALTER TABLE xtandard_audit MODIFY `key` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
```

## The key model

Root `aud`, slash-delimited — see the module doc in `src/keys.ts` for the full layout:

```txt
aud/tenants                                          -> string[] index
aud/actions                                          -> string[] index (catalog)
aud/actions/{name}                                   -> ActionDefinition
aud/t/{tenant}/head                                  -> ChainHead
aud/t/{tenant}/checkpoints/{chk id}                  -> AuditCheckpoint (time-sortable id)
aud/streams/{stream}/cursors/{tenant}                -> StreamCursor
aud/streams/{stream}/lease                           -> StreamLease

— generic event log (KV fallback only) —
aud/t/{tenant}/events/{seq 12}                       -> AuditEvent
aud/t/{tenant}/ids/{event id}                        -> seq
aud/t/{tenant}/ix/time/{ms 13}~{id}                  -> seq
aud/t/{tenant}/ix/actor/{actorId}/{ms 13}~{id}       -> seq
aud/t/{tenant}/ix/action/{action}/{ms 13}~{id}       -> seq
aud/t/{tenant}/ix/target/{type}/{id}/{ms 13}~{id}    -> seq
```

Zero-padded numbers make lexicographic key order equal numeric order, so a sorted `getKeys` scan yields events by seq (or by `occurredAt` for the `ix/` indexes) on every backend; the conformance suite asserts it. Free-form segments are `encodeURIComponent`-escaped. The fallback's queries pick the most selective index, walk it in `(occurredAt, id)` order and filter in memory — O(index size) key listing per query.

## Choosing a backend

| Workload                                                      | Recommendation                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| tests, demos, local dev                                       | `memory`                                                                        |
| a single node with local disk                                 | `sqlite` (Bun) or `libsql` with a `file:` URL                                   |
| production, you already run Postgres / MySQL                  | `postgres`, or `drizzle` with the tables in your migrations                     |
| edge / multi-region                                           | `libsql` (Turso)                                                                |
| small volumes on a KV you already run (Redis, Cloudflare KV…) | the KV adapters — fine for modest tenants; configure retention to bound the log |

Native event logs keep queries indexed at any volume; the KV fallback scans one index per query and is meant for development and small tenants.

## Multi-writer posture

Several processes can record for the same tenant ([ADR 0004](./ADR/0004-tamper-evidence-hash-chain-checkpoints.md) §7):

| Storage                              | Cross-process chain safety                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| native event log (all SQL drivers)   | ✓ — `appendEvents` checks the head and `PRIMARY KEY (tenant, seq)` rejects a racing writer; the core re-chains and retries |
| KV fallback with `compareAndSwap`    | ✓ — the core claims the seq range with a CAS on the chain head (redis; file within one process)                            |
| KV fallback without `compareAndSwap` | single writer per tenant assumed (unstorage, Cloudflare KV) — run recording in one process or pick a native/CAS backend    |

In-process, appends to a tenant are always serialized by a per-tenant mutex.

## Writing your own adapter

Implement the four KV methods — and, for indexed queries, the `EventLogStorage` methods — then run the conformance suite from this repo's `test/storage-contract.ts` against it:

```ts
import { describe, expect, test } from "vitest";
import { runStorageContractTests } from "./storage-contract.ts";

runStorageContractTests("my-backend", () => createMyStorage(/* fresh, empty */), {
  t: { describe, test, expect },
  capabilities: { compareAndSwap: true, watch: false }, // declare every capability
  expectNativeEventLog: true, // asserts hasEventLog(storage)
});
```

It runs the kit's KV conformance suite (`@xtandard/kit/storage/testing`: round-trips, prefix isolation, metacharacters, unicode, empty segments, padded-key ordering, CAS and watch semantics, legacy values) under the `aud` key root; the event log through the core (contiguous chained seqs, every query filter, keyset pagination in both orders and stability under new writes, `eventsBySeq`, counts, batches, idempotent re-records, concurrent records, erasure, tamper detection, prune + continued appends); and, for native adapters, `appendEvents` atomicity and `ChainConflictError`. Use `withWatch(storage, subscribe)` to bolt change notifications onto any adapter from whatever signal your infra already has (`pgListenNotify` ships for Postgres `LISTEN/NOTIFY`).
