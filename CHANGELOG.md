# Changelog

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
