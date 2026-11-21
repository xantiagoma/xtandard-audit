# Changelog

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
