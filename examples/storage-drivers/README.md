# storage-drivers × @xtandard/audit

One contract, every backend. `AuditStorage` is a four-method KV contract plus an
optional **native event log** capability (indexed SQL/Mongo queries); drivers
without it get the generic KV event log. This script runs the **same scenario**
against every backend that needs no server and prints the same answers:

```txt
          events  invoice.*  by grace  → alan  failures  "refund"  Oct 2  first 3 (asc) | page 2  verify           log
memory    40+20   24         20        12      12        12        24     8V9W 45B1 54Y3 | EV7M   ok 40 signed→40  native
file      40+20   24         20        12      12        12        24     8V9W 45B1 54Y3 | EV7M   ok 40 signed→40  kv fallback
sqlite    40+20   24         20        12      12        12        24     8V9W 45B1 54Y3 | EV7M   ok 40 signed→40  native
pglite    40+20   24         20        12      12        12        24     8V9W 45B1 54Y3 | EV7M   ok 40 signed→40  native
postgres  40+20   24         20        12      12        12        24     8V9W 45B1 54Y3 | EV7M   ok 40 signed→40  native
redis     40+20   24         20        12      12        12        24     8V9W 45B1 54Y3 | EV7M   ok 40 signed→40  kv fallback
mongodb   40+20   24         20        12      12        12        24     8V9W 45B1 54Y3 | EV7M   ok 40 signed→40  native

Identical results on 7 backends — that is the whole point.
```

(The last three rows appear when `DATABASE_URL`, `REDIS_URL` and `MONGO_URL` are set; ids differ per run.)

The scenario: 60 events in two tenants (fixed ids, so the pages line up) →
queries by action family, actor, target, outcome, full-text search, time range
and keyset pagination → a signed checkpoint → `verify`. The script exits non-zero
if any backend disagrees.

| Backend           | Import                             | Needs                                         |
| ----------------- | ---------------------------------- | --------------------------------------------- |
| memory            | `@xtandard/audit/storage/memory`   | —                                             |
| file              | `@xtandard/audit/storage/file`     | — (`./.audit/<run>`)                          |
| sqlite            | `@xtandard/audit/storage/sqlite`   | the Bun runtime (`bun:sqlite`)                |
| postgres (PGlite) | `@xtandard/audit/storage/postgres` | `@electric-sql/pglite` (in-process, WASM)     |
| libsql (`file:`)  | `@xtandard/audit/storage/libsql`   | `@libsql/client` (an optionalDependency here) |
| postgres          | `@xtandard/audit/storage/postgres` | `DATABASE_URL` + `bun add pg`                 |
| redis             | `@xtandard/audit/storage/redis`    | `REDIS_URL` + `bun add redis`                 |
| mongodb           | `@xtandard/audit/storage/mongodb`  | `MONGO_URL` + `bun add mongodb`               |

Also available, same contract: `storage/drizzle` (+ `drizzle/{pg,mysql,sqlite}`
tables — see [`../postgres`](../postgres)), `storage/unstorage` (dozens of
drivers) and `storage/cloudflare-kv` (a Workers KV binding).

## Run it

```bash
bun install
bun run start
# or from the repo root:  bun run examples:storage-drivers
DATABASE_URL=postgres://… REDIS_URL=redis://localhost:6379 bun run start   # include network backends
```

## Files

- [`src/index.ts`](./src/index.ts) — the scenario, one `run()` per backend, the table and the agreement check.
