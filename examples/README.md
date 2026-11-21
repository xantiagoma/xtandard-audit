# Examples

Each example is a standalone mini-project — copy it out, `bun install`, run.

| Example                                           | What it shows                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`hono/`](./hono)                                 | Panel at `/audit` + a team-settings app that records on real user actions through `auditContext` (Hono). |
| [`elysia/`](./elysia)                             | The same app with Elysia (`auditContext` plugin after your auth plugin), SQLite storage.                 |
| [`express/`](./express)                           | The same app with Express (panel mounted **before** the body parser).                                    |
| [`bun/`](./bun)                                   | The same app on plain `Bun.serve` + `withAuditContext`.                                                  |
| [`auth/`](./auth)                                 | none / basic / delegated auth + admin / auditor / viewer roles, with a portal-token mint route.          |
| [`portal-embed/`](./portal-embed)                 | `<AuditPortal>` inside a host React app, cross-origin, with a server minting portal tokens.              |
| [`storage-drivers/`](./storage-drivers)           | One contract, every serverless backend (memory, file, sqlite, PGlite, libsql) — the same answers.        |
| [`postgres/`](./postgres)                         | Docker Postgres + the audit tables in your Drizzle schema (`pgAuditTables()`), migrated by drizzle-kit.  |
| [`siem-streaming/`](./siem-streaming)             | HTTP + Standard Webhooks + checkpoint-witness streams; the receiver fails first, you watch lag drain.     |
| [`drizzle-audit-bridge/`](./drizzle-audit-bridge) | drizzle-audit row changes on PGlite → `createDrizzleAuditStorage` → the chained, tenant-scoped log.      |
| [`verify-export/`](./verify-export)               | Export signed bundles; verify offline with `@xtandard/audit/verify` and `xtandard-audit verify` (0/2/1). |
| [`standalone-docker/`](./standalone-docker)       | The standalone image + Postgres with `docker compose`: auth, signing key, portal, retention via env.     |

## Storage backends

Every backend implements the same `AuditStorage` contract (a four-method KV
plus an optional native event log for indexed queries), so any of them can hold
the whole log. Where each is demonstrated:

| Backend                   | Import                                                 | Demonstrated in                                                   |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| memory                    | `@xtandard/audit/storage/memory`                       | [`storage-drivers/`](./storage-drivers), `bun/`, `auth/`, the demo |
| file                      | `@xtandard/audit/storage/file`                         | [`hono/`](./hono), [`express/`](./express), `storage-drivers/`     |
| sqlite (`bun:sqlite`)     | `@xtandard/audit/storage/sqlite`                       | [`elysia/`](./elysia), `storage-drivers/`                          |
| libsql / Turso            | `@xtandard/audit/storage/libsql`                       | `storage-drivers/` (a `file:` URL)                                 |
| postgres (pg / PGlite)    | `@xtandard/audit/storage/postgres`                     | `storage-drivers/`, [`drizzle-audit-bridge/`](./drizzle-audit-bridge), `standalone-docker/` |
| drizzle (pg/mysql/sqlite) | `@xtandard/audit/storage/drizzle` + `drizzle/{pg,…}`   | [`postgres/`](./postgres) — your schema, your migrations           |
| redis                     | `@xtandard/audit/storage/redis`                        | `storage-drivers/` (behind `REDIS_URL`)                            |
| mongodb                   | `@xtandard/audit/storage/mongodb`                      | `storage-drivers/` (behind `MONGO_URL`)                            |
| cloudflare-kv             | `@xtandard/audit/storage/cloudflare-kv`                | Workers KV binding                                                 |
| unstorage (dozens more)   | `@xtandard/audit/storage/unstorage`                    | bridge to Upstash, S3, Vercel KV, …                                |

These examples depend on the package via `file:../..`, so they run against
your local checkout. **Build the package once at the repo root first** (`dist/`
must exist; the admin SPA needs `bun run build:ui` — without it the panel's API
works and the page says how to build it):

```bash
cd ..            # repo root
bun install
bun run build    # builds dist/ (lib)
```

When using the published package instead, swap the dependency for
`"@xtandard/audit": "^0.1.0"`.

## Run from the repo root (auto-install + free port)

From the repo root, after `bun run build`, convenience scripts install the
example on first use and launch it on a **free port** (via `get-port-please`,
so you can run several at once without collisions):

```bash
bun run examples:hono                   # or: elysia | express | bun
bun run examples:auth                   # AUTH_DEMO=none|basic|delegated|roles
bun run examples:portal-embed           # host app on :5191, panel on :3702
bun run examples:storage-drivers        # script example (no server)
bun run examples:postgres               # docker compose up + drizzle-kit push + run
bun run examples:siem-streaming         # streams with failures, backoff and catch-up
bun run examples:drizzle-audit-bridge
bun run examples:verify-export          # bundles + CLI exit codes 0 / 2 / 1
```

Each server example prints the URL it chose, e.g. `> hono → http://localhost:3001`.

## The flagship demo

For a fully seeded playground — four customer tenants with six weeks of
realistic history (sign-ins, member changes, invoices paid / failed / refunded,
API keys, SSO, deployments, exports, GDPR erasures), daily Ed25519 checkpoints,
a pruned retention window, a SIEM stream catching up and a customer's Splunk
stream stuck on a revoked token, plus portal links — run the demo from the repo
root instead:

```bash
bun run demo                       # → http://localhost:7790
DEMO_LIVE=0 bun run demo           # no live trickle of new sign-ins (stable screenshots)
bun run seed:demo                  # seed the CLI-configured storage instead (STORAGE_DRIVER=file → ./.audit)
```
