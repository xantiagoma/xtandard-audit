# Changelog

## v0.2.0

[compare changes](https://github.com/xantiagoma/xtandard-audit/compare/v0.1.2...v0.2.0)


### Changed

- **`@xtandard/kit` is a dependency.** The storage drivers' KV side, the drizzle KV tables, auth,
  authorization, the hooks runner, ids, durations, canonical JSON, the validation core, portal
  tokens, the panel handler and API plumbing, the framework adapters, the CLI plumbing, the admin
  shell and React embed, the build configs and the docs site come from the kit. Every subpath and
  exported name is kept (api-surface: 8 added, 0 removed). Persisted names are passed explicitly:
  table `xtandard_audit`, Mongo `xtandard_audit` / `audit_kv` (CLI: `audit`), pg channel
  `xtandard_audit`, file `legacy: "ignore"`, readonly `423`, token prefix `audpt_` with a 1 h TTL,
  ULID ids, realm `xtandard-audit`, `__AUDIT_CONFIG__`, `xtandard-audit:theme`, `.xtandard-audit`,
  `intParam` invalid → `400 BAD_QUERY`.
- **The native event log stays in audit** and now runs on the kit drivers' own connection: one
  lazy connection per storage, the KV and event-log DDL run once and are retried after a failure
  (libSQL, sqlite and Mongo indexes too; Postgres already retried).
- **`compareAndSwap` on every driver but unstorage and Cloudflare KV**: file (in-process), sqlite,
  libSQL, Postgres, MongoDB and Drizzle (Postgres, MySQL, SQLite) gain it (memory and redis had
  it). The core claims a KV-fallback chain head with it, so the file driver is safe for concurrent
  records in one process.
- **KV values are written as canonical JSON** (object keys sorted) on every driver. Reads of
  existing data are unchanged, and `compareAndSwap` on a value written by an earlier release falls
  back to a structural comparison and swaps on the stored form. Events stored by the KV fallback
  (file, redis, unstorage, Cloudflare KV) are written with sorted keys; the integrity hash is over
  canonical JSON already, so verification is unaffected.
- **New Postgres KV tables** are created with `key text COLLATE "C"` (bytewise, index-usable
  prefixes). Existing tables are not altered and keep working. Optional:
  `ALTER TABLE xtandard_audit ALTER COLUMN key TYPE text COLLATE "C";`
- **`createSqliteStorage` creates its tables on first use** (it did in the constructor), and
  `bun:sqlite` is loaded then too, so `@xtandard/audit/storage/sqlite` now imports under Node
  (opening a database still needs Bun).
- **Drizzle**: the dialect is read from `db` (or pass the new `dialect` option), and `drizzle-orm`
  is loaded on first use by `@xtandard/audit/storage/drizzle`. `mysqlAuditTable` /
  `mysqlAuditTables` take `keyCollation` (`utf8mb4_bin` default, `utf8mb4_0900_bin`,
  `utf8mb4_nopad_bin`). The KV key columns are unchanged, so drizzle-kit generates no `ALTER`.
- **Driver errors name the audit subpath** with the kit's wording, e.g. `@xtandard/audit/storage/
  mongodb requires the optional peer "mongodb". Install it with: …` and `… requires either a
  \`client\` or a \`url\``.
- **Panel**: `/healthcheck` answers `{ "ok": true }` inside every panel (`{basePath}/healthcheck`);
  the CLI/image keeps its `{ status, title }` healthcheck in front of it. The SPA is served
  `cache-control: no-cache`; a non-GET on a non-API path is `405` with `Allow: GET, HEAD`.
  `createFetchHandler` without `storage` or `core` throws `createFetchHandler requires either
  \`storage\` or \`core\`.`
- **OpenAPI `info.version`** is the package version (was a hard-coded `0.1.0`).
- **Portal tokens** accept a list of secrets for rotation (the first signs, any verifies); the wire
  format is unchanged (the payload's field order may differ: `{ tenant, filter?, exp }`).
  `PortalTokenError` keeps its name and `instanceof` works on errors from `verifyPortalToken`.
- **CLI**: `STORAGE_SQLITE_TABLE` (sqlite and libSQL table) and `STORAGE_LIBSQL_URL` are new;
  `--help`, `--version` and `--json` never take a value; a value starting with `--` (or `-h` /
  `-v`) is read as the next flag, while negative numbers and a bare `-` stay values
  (`--limit -1`).
- **UI**: the admin shell is the kit's `ShellFrame` (the active tab underline uses the accent
  colour). A `#token=…` link works like `?token=…` for the standalone portal.
- **Docs site** built with `@xtandard/kit/site` (favicon sizes, `theme-color`, `og:image:alt`).
- **CI** runs the kit's reusable workflows; `redis:8`, so the RedisJSON conformance runs live.

### Fixed

Inherited from the kit (inventory §3.2/§3.3, PLAN §7, `build-*.md`):

- **MySQL (Drizzle) keys that differ only by trailing spaces no longer collide.** `utf8mb4_bin` is
  PAD SPACE, so `"a "` and `"a"` were the same key. Reads, removes and swaps now match byte-exactly,
  and a write that would overwrite the other spelling throws `KeyCollisionError` (exported from
  `@xtandard/audit/storage/drizzle`). Audit's own keys never end in a space, and the HTTP API now
  answers `404` for a padded tenant or event id (`400` for a padded `?tenant=`) instead of reading
  the near-spelling from the native event tables. New tables can use
  `mysqlAuditTable(name, { keyCollation: "utf8mb4_0900_bin" })`.
- **MySQL (Drizzle) `getKeys` no longer skips keys with emoji** (supplementary characters): an
  indexed `LIKE 'p%'` on `utf8mb4_bin` missed them on MySQL 8.4; it is now a bytewise range.
- **unstorage: a stored string that looks like JSON stays a string** (`"123"` came back as `123`).
  Strings are written JSON-encoded; strings stored by earlier releases read as before.
- **Postgres / Drizzle: a stored JSON string that looks like JSON stays a string** (it was parsed
  twice).
- Redis `getKeys` no longer returns duplicates (SCAN may repeat keys).
- Redis `compareAndSwap` no longer treats `{}` and `[]` as equal (the Lua compared `cjson`-decoded
  values); a value written by an earlier release still swaps.
- Empty key segments are distinct keys on the file and unstorage drivers (`a//b` ≠ `a/b`).
- unstorage keys ending in `$` are no longer hidden as unstorage meta keys.
- SQLite / libSQL prefixes use `GLOB` (case-sensitive and index-usable), Mongo `getKeys` re-checks
  `startsWith` (a case-insensitive collection collation never leaks keys).
- libSQL and MongoDB: a failed connect or DDL is retried on the next call instead of cached.
- In-memory `compareAndSwap` compares own properties (`{ a: undefined }` ≠ `{ b: undefined }`).
- `withWatch(storage, …)` results survive a spread.
- The panel title, base href and bootstrap JSON are escaped in `index.html` (the title was
  written raw).
- Express / Node bridge: every `Set-Cookie` header is kept (they were collapsed into one),
  multi-value request headers are appended, pre-parsed urlencoded bodies are re-serialised, `HEAD`
  gets no body.
- Elysia: `PATCH` and `DELETE` bodies are rebuilt too, a stale `content-length` is dropped, and two
  `auditElysia` mounts with different prefixes are no longer deduplicated.
- A portal token is rejected with an empty secret, on create and on verify.
- The standalone SPA strips `?token=` / `#token=` from the address bar (no bookmarking, sharing
  or `Referer` leak); a token means portal from the first render.
- React embed: the memory router keeps its query string (`?tenant=`), and `AuditPortal` refetches
  everything when its token changes and clears it on unmount.
- An empty environment variable counts as unset (`PORT=` → `3000`).
- `Authorization: bearer …` is accepted case-insensitively for portal tokens.
- Domain errors from another bundle map by name (unchanged for audit's own; now also
  `*TokenError`).
- The panel serves the SPA on Node 20.0–20.15 (it served the "UI not built" page there:
  `process.getBuiltinModule` is missing before Node 20.16), and the CLI's main-module check
  works there too.
- Portal tokens and event ids follow fake timers that swap the global `Date`
  (`vi.setSystemTime`): the clock is read at mint time.
- The CLI reports a storage driver whose module is missing from the build as "not available in
  this build" instead of a raw import error.

### Migration

No action is needed for stored data, the HTTP API or the CLI. Two edge cases:

- **Drizzle over a wrapped `db`**: `createDrizzleStorage` detects the dialect from `db.dialect`.
  If your `db` is a proxy or a custom wrapper without it, pass `dialect: "pg" | "mysql" | "sqlite"`.
- **MySQL Drizzle tables** (optional): to let keys that differ only by trailing spaces coexist
  instead of raising `KeyCollisionError`, migrate the key column to a NO PAD collation:
  `ALTER TABLE xtandard_audit MODIFY \`key\` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;`
  (MariaDB: `utf8mb4_nopad_bin`).

## v0.1.2

[compare changes](https://github.com/xantiagoma/xtandard-audit/compare/v0.1.1...v0.1.2)

Security fix for the standalone server, the CLI and the Docker image: a mistyped `AUTH_MODE` no longer serves an open panel. Library APIs, storage and the HTTP API are unchanged.

### 🩹 Fixes

- **auth:** reject unknown `AUTH_MODE` instead of serving an open panel ([#25](https://github.com/xantiagoma/xtandard-audit/pull/25)). Any value other than `none` or `basic` (a typo, wrong case) used to fall through to `none`, leaving the admin panel and API unauthenticated. The server now exits with `Unknown AUTH_MODE "x" (expected none or basic)` before it listens. An empty or unset `AUTH_MODE` still means `none`, and now prints the same unauthenticated-panel warning as an explicit `none`.

### Migration

None if `AUTH_MODE` is `none`, `basic` or unset. If a deployment fails to start after upgrading, its `AUTH_MODE` was invalid and the panel was open: set it to `basic` (with credentials) or `none` explicitly.

## v0.1.1

Branding polish in the shipped UI. No API, storage, integrity-format or HTTP changes.

### Changed

- **UI** — the admin SPA, the customer portal and the `<AuditDashboard>` / `<AuditPortal>` React embeds show the bare xtandard-audit symbol in the header (no square tile), in each theme's lime: a new light-theme variant on light surfaces, the original on dark. A custom `logoUrl` still replaces it. ([#22](https://github.com/xantiagoma/xtandard-audit/pull/22))
- **README** — the header, the docs site and the brand kit use SVG logos only; the horizontal lockups centre the symbol vertically on the wordmark ([#23](https://github.com/xantiagoma/xtandard-audit/pull/23)). The ecosystem table lists `@xtandard/links` and `@xtandard/entitlements`. This also fixes the logo in the README shown on npm, which pointed at PNG lockups that no longer exist.

### Internal

- The pre-commit `vp staged` hook no longer fails on commits that stage only `.mdx` files or `CHANGELOG.md` ([#24](https://github.com/xantiagoma/xtandard-audit/pull/24)).

### Migration

None. Drop-in upgrade from 0.1.0: stored events, checkpoints, bundles and stream cursors are unchanged, and nothing needs re-verifying. If you style the panel header with your own CSS, note the symbol is now a bare `<img>` (`h-6`) instead of an image inside a 28 px dark chip.

## v0.1.0

First release: a self-hosted, embeddable, tamper-evident audit-log control plane for B2B SaaS, as a library. See the [documentation](https://me.xantiagoma.com/xtandard-audit/) and the [ADRs](docs/ADR).

### Added

- **Record plane** — `createAuditCore().record()` / `recordMany()`: typed per-action metadata via any Standard Schema validator (`defineActions`), strict action catalog, transforms (`redact`, `mask`, `hashValue`, `omit`), ambient request context (`@xtandard/audit/context`), idempotent re-record by explicit id. Synchronous-commit; `createRecorder()` for buffered fire-and-forget recording with retries, a fallback sink and backpressure.
- **Tamper evidence** — a hash chain per tenant with salted per-section digests, Ed25519 / HMAC signed checkpoints (automatic every N events or interval), `verify()` with precise issue kinds, a zero-dependency verifier (`@xtandard/audit/verify`), verifiable JSONL export bundles, and GDPR erasure that keeps the chain verifiable (erasures must be justified by a chained `audit_log.erased` record).
- **Query** — tenant, action families, actor, target, outcome, time range and free-text filters with keyset pagination; the result is `@xtandard/lib`'s `Paginated<T>` envelope.
- **Storage** — the four-method KV contract plus an optional native event-log capability: memory, Postgres, SQLite, libSQL, MongoDB and Drizzle (pg / mysql / sqlite) query natively; file, Redis (with compare-and-swap), unstorage and Cloudflare KV use the generic KV-index fallback. One conformance suite for every driver.
- **Exports and streaming** — CSV (formula-injection safe), JSON, JSONL and bundles; a pull-based stream runner with per-tenant cursors, backoff and leases; sinks for HTTP, Standard Webhooks, `@xtandard/webhooks`, Datadog, Splunk HEC, S3-compatible stores, console and files.
- **Panel** — `createFetchHandler` with the JSON API, OpenAPI 3.1, JWKS, retention maintenance and the stream runner; adapters for Bun, Hono, Express, Elysia and Elysia 2 (typed Eden), each with an `auditContext()` middleware; auth (`none` / `basic` / `delegated`) and authorization (`none` / `roles` / `delegated`).
- **UI** — the bundled admin SPA (overview, events explorer, tenants, action catalog, integrity, streams), the customer portal chrome behind signed portal tokens with server-side view filters, and the `<AuditDashboard>` / `<AuditPortal>` React embeds.
- **Bridges** — `@xtandard/audit/drizzle-audit` (forward and import drizzle-audit entries).
- **Tooling** — the `xtandard-audit` CLI (serve, record, query, export, verify with 0/2/1 exit codes, prune, checkpoint, keygen), a standalone Docker image, `@xtandard/audit/testing`, examples, and the docs site.
