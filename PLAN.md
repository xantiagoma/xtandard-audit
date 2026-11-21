# PLAN — `@xtandard/audit`

> Self-hosted, embeddable, tamper-evident audit-log control plane for B2B SaaS — as a library.
> The WorkOS Audit Logs / Retraced niche, in the exact shape of `@xtandard/flags` and
> `@xtandard/webhooks`.

Single source of truth for _what we are building and in what order_. Day-to-day status lives in
[WORKLOG.md](./WORKLOG.md). The brief is [MISSION.md](./MISSION.md); the market research is
[docs/research/landscape.md](./docs/research/landscape.md); decisions are in [docs/ADR](./docs/ADR).

## North star

- `record()` is the hot path: it lives in the host's request handlers, so it is cheap, typed, and
  **never loses an event silently** — it either commits, or the failure is loud (throw / `onError`
  / fallback sink), never swallowed.
- Every tenant's log is **verifiable by the tenant**: a per-tenant hash chain plus signed
  checkpoints, an export bundle that carries its own proof, and a zero-dependency verifier.
- **Your database, your process**: `bun add` + the storage you already run. The admin UI and the
  customer-facing viewer mount inside the host app; nothing to operate.
- Batteries included, not required: every official piece is an implementation of a public contract
  (storage, auth, authorization, sinks, signers).

## Reference repos and how closely we mirror them

`xtandard-flags` and `xtandard-webhooks` are **the** references for structure, tooling, naming and
docs; anything that differs is recorded in an ADR (index below). `drizzle-audit` and `@xtandard/lib`
are secondary references (transforms/context capture, and query/pagination conventions).

| Area                | Mirrors                                                                 | Notes                                                                 |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Package layout      | webhooks: `src/entry-*.ts` + `exports` + `vp pack` dual ESM/CJS         | ADR 0001                                                              |
| Storage drivers     | the same 10 drivers, same factory names/options, `requirePeer`          | + optional native `EventLogStorage` capability (ADR 0005)             |
| Server              | `createFetchHandler` → `{ fetch, core, openapi }`, tiny router, OpenAPI | same base-path, CORS, static assets, SPA fallback                     |
| Auth/authorization  | `auth/{none,basic,delegated}`, `authorization/{none,roles,delegated}`   | audit-specific action set                                             |
| Portal              | webhooks portal tokens (HMAC, stateless) + same-SPA reduced chrome      | + optional server-side view filter (ADR 0006)                      |
| UI                  | same SPA stack, tokens, primitives, theme, toasts; `react` embeds       | `<AuditDashboard>` + `<AuditPortal>`                               |
| Hooks               | `before` (veto) / `after` (side effects) around control-plane mutations | `record` has its own fire-and-forget `onRecord` tap, like `onDelivery` |
| Adapters            | `{elysia,elysia2,hono,express,bun}` exporting `auditPanel`              | + `auditContext` middleware per framework (ADR 0013)                  |
| CLI                 | `bin/xtandard-audit.mjs` → `dist/cli`                                   | serve / record / query / export / verify / prune / checkpoint / keygen |
| Tests               | vitest projects (core + elysia2), `*.bun.test.ts`, storage conformance  | playwright e2e for SPA + embeds; `test-d` type tests                  |
| Docs                | README sections, `docs/*.md` set, ADRs, CHANGELOG (changelogen)         | Starlight site in `site/` + `pages.yml`                               |
| Release             | `release.yml` (tag push → npm trusted publishing/OIDC)                  | identical flow                                                        |

## Domain model (summary — `src/schema.ts` is authoritative)

```ts
interface AuditEvent {
  id: string;            // "evt_" + 26-char time-sortable id (ADR 0010)
  tenant: string;        // the customer organization the event belongs to
  seq: number;           // per-tenant, contiguous from 1 (chain position)
  action: string;        // "invoice.paid", "user.login", "member.role_changed"
  occurredAt: string;    // ISO-8601, when it happened (caller-supplied or now)
  recordedAt: string;    // ISO-8601, when the log accepted it
  actor: AuditActor;     // { id, type?, name?, email?, metadata? }
  targets: AuditTarget[];// [{ type, id, name?, metadata? }]
  context: AuditContext; // { ip?, userAgent?, requestId?, location?, … }
  metadata: JsonObject;  // action-specific, typed per action (ADR 0012)
  outcome?: "success" | "failure";
  description?: string;
  integrity: { prevHash: string; hash: string; digests: Record<Section, string> }; // ADR 0004
}
```

Control data: the **action catalog** (`name`, `description`, `group`, `targets`, `version`,
JSON-Schema-ish `metadata` shape for the UI), **tenants** index (implicit — created on first event),
**checkpoints** (signed chain heads), **stream cursors**, and the internal **operator log**.

## Module layout

```txt
src/
  index.ts              root: core, schema, integrity, portal tokens, hooks, contracts, handler
  core.ts               createAuditCore: record/recordMany, query, get, export, verify,
                        checkpoints, retention, erasure, catalog, tenants
  schema.ts             types (AuditEvent, AuditQuery, Checkpoint, ActionDefinition, …)
  validation.ts         valibot input validation (record path + admin path)
  standard-schema.ts    vendored Standard Schema v1 types (zero dep) for typed actions
  canonical.ts          canonical JSON (RFC 8785-style key ordering)
  integrity.ts          hashing, chain building, verifyChain, signers (Ed25519 / HMAC)
  verify.ts             zero-dep verifier entry for auditors (`@xtandard/audit/verify`)
  id.ts                 time-sortable ids
  keys.ts               KV key layout for the generic event-log fallback
  query.ts              query normalization, cursor codec, in-memory matcher (KV fallback)
  export.ts             CSV / JSON / JSONL streaming + verifiable bundle
  recorder.ts           buffered, batching recorder with retry + fallback (never-lose)
  transforms.ts         redact / mask / hash / omit (ported from drizzle-audit)
  context.ts            AsyncLocalStorage request context (actor, ip, ua, request id)
  streams.ts            stream runner: pull-based, per-tenant seq cursors (ADR 0008)
  sinks/                http, webhook (Standard Webhooks signed), xtandard-webhooks bridge,
                        datadog, splunk-hec, s3 (aws4fetch peer), console, callback
  bridges/drizzle-audit.ts  drizzle-audit `AuditStorage` → @xtandard/audit (ADR 0009)
  portal.ts             portal tokens (stateless HMAC, tenant-scoped, optional filter)
  testing.ts            in-memory core, collecting sink, assertions
  storage/              contract, memory, file, redis, postgres, drizzle, mongodb, sqlite,
                        libsql, unstorage, cloudflare-kv, watch
  drizzle/              pg / mysql / sqlite table helpers
  auth/ authorization/ hooks/ server/ adapters/   (mirrors webhooks)
  ui/                   React SPA → dist/ui (admin + portal chrome)
  react.tsx             <AuditDashboard>, <AuditPortal>
  cli.ts                xtandard-audit CLI
apps/standalone/        Bun server + Dockerfile
examples/               hono, elysia, express, bun, portal-embed, auth, storage-drivers,
                        postgres, siem-streaming, drizzle-audit-bridge, verify-export
site/                   Starlight docs site
```

## Phases

1. **Research gate** — `docs/research/landscape.md`, verdict to t1r. ✅ when committed.
2. **Design** — this file + ADRs 0001–0013, report to t1r.
3. **Scaffold** — repo tooling copied from webhooks (package.json scripts, vite-plus, oxlint/oxfmt,
   tsconfigs, husky, mise, CI, release, LICENSE, CLAUDE.md). GitHub repo created.
4. **Spine** (lead) — schema, ids, canonical, integrity, storage contract + memory driver + KV
   fallback, core (record/query/verify/checkpoint/retention/erasure/catalog), recorder,
   transforms, conformance suite. Unit tests.
5. **Fan-out** (workers in worktrees, disjoint files):
   - storage drivers + conformance across drivers;
   - server/routes/openapi/portal/auth/authorization/adapters/context middleware/CLI/standalone;
   - UI SPA (admin + portal chrome) + React embeds + playwright e2e;
   - streams + sinks + drizzle-audit bridge + examples.
6. **Docs** — README (+ ecosystem section), `docs/*.md`, CHANGELOG, site + `pages.yml`, Pages live.
7. **Release prep** — `release.yml`, publint, `npm pack --dry-run`, READY TO PUBLISH to t1r,
   sibling ecosystem-table lines.

## Definition of done

See MISSION.md. Gate: `bun run check && bun run test && bun run test:bun && bun run test:e2e`
green locally and in GitHub Actions.

## ADR index (★ = deviation from flags/webhooks)

| ADR  | Decision                                                                          |
| ---- | --------------------------------------------------------------------------------- |
| 0001 | Single package, subpath exports (mirrors)                                         |
| 0002 | Record path never loses events silently; control vs record plane ★                |
| 0003 | Bundled SPA UI + React embeds (mirrors)                                           |
| 0004 | Tamper evidence: per-tenant hash chain, sectioned digests, signed checkpoints ★   |
| 0005 | Storage: KV contract + optional native `EventLogStorage` capability ★             |
| 0006 | Portal tokens: stateless HMAC, tenant-scoped, + optional view filter ★            |
| 0007 | Query model + keyset pagination; no runtime dependency on `@xtandard/lib` ★       |
| 0008 | Streaming: pull-based sinks with per-tenant sequence cursors ★                    |
| 0009 | Relationship with `drizzle-audit`: capture layer vs control plane                 |
| 0010 | Time-sortable event ids ★                                                         |
| 0011 | Erasure vs immutability: redact sections, keep digests ★                          |
| 0012 | Typed actions via Standard Schema (validator-agnostic) ★                          |
| 0013 | Request context capture via AsyncLocalStorage middleware ★                        |
