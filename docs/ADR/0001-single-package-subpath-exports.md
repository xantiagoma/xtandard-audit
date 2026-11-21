# ADR 0001 — Single Package with Subpath Exports

**Status:** Accepted (mirrors `@xtandard/flags` ADR 0001 and `@xtandard/webhooks` ADR 0001)

---

## Context

`@xtandard/audit` ships a large surface: the core (record, query, verify, export, retention), the
integrity primitives and a zero-dependency verifier, a buffered recorder, transforms, request-context
capture, stream sinks (HTTP, Standard Webhooks, Datadog, Splunk HEC, S3), storage adapters (memory,
file, Redis, Postgres, Drizzle, MongoDB, SQLite, libSQL, unstorage, Cloudflare KV), auth and
authorization providers, framework adapters (Elysia, Hono, Express, Bun), a bundled admin SPA, React
embeds, a CLI and test helpers. Many of these pull optional peers (`pg`, `redis`, `mongodb`,
`drizzle-orm`, `elysia`, `react`, `aws4fetch`, …).

Both siblings faced the identical trade-off (multiple packages vs one entry vs one package with
subpaths) and settled it the same way.

## Decision

Ship `@xtandard/audit` as a **single npm package with explicit subpath exports** mapping to thin
`src/entry-*.ts` re-export entrypoints, built by vite-plus (`vp pack`) into dual ESM/CJS bundles with
`.d.mts`/`.d.cts` declarations — the mechanism proven in flags and webhooks.

Every new subpath requires four edits, or CI-only failures appear: `src/entry-*.ts`, `vite.config.ts`
`pack.entry`, `package.json` `exports`, and `examples/tsconfig.json` `paths`.

`record()` and `verify` are hot or auditor-facing paths and have **zero optional dependencies**.

## Consequences

- One version, one release pipeline, one README, one docs site.
- Missing optional peers fail at import time with an actionable `requirePeer` message.
- `publint` and `bun pm pack --dry-run` guard the exports map in CI.
