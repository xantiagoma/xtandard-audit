# WORKLOG — `@xtandard/audit`

Reverse-chronological. Each entry: timestamp · task · files · tests · blocker · next.

---

## 2026-11-21 — feature-complete, docs live, release-ready

- Merged PRs #1–#21: spine; KV + SQL + Mongo storage (native event log on memory/postgres/sqlite/
  libsql/mongodb/drizzle pg+mysql+sqlite); sinks + @xtandard/webhooks and drizzle-audit bridges;
  server/adapters/auth/portal/CLI/standalone; brand kit; admin SPA + portal + React embeds (browser
  e2e in CI); examples + seeded demo; docs site on Pages; release prep (v0.1.0).
- Fixes from sibling leads: case-exact keys + literal prefixes (file/SQL/unstorage/redis), unstorage
  namespace listing; drizzle-audit tenantId + content-derived ids.
- Workers (hc, worktrees): research, storage-sql, storage-kv, server, ui, sinks, brand, site,
  examples. All heavy jobs via the shared heavy.sh semaphore; pushes with --no-verify after the gate.
- Known gaps: Drizzle `*AuditTables()` return structural (not precise `PgTableWithColumns`) types;
  Mongo multi-event appends have a documented non-transactional race window; examples install via
  `file:../..` is slow (bun copies the repo); Merkle proofs / external anchoring are future work
  (ADR 0004).

## 2026-11-20 — research gate + design

- Research gate (worker `audit-research`): `docs/research/landscape.md`. Verdict: no permissive +
  maintained + embeddable-library equivalent (Retraced = heavy service, no release since 2024-11,
  per-event hash only; AuditKit = AGPL + proprietary ee; WorkOS/Pangea = SaaS; the rest are
  ORM/framework row-diff plugins). → build.
- Design: `PLAN.md` + ADRs 0001–0013 (deviations from flags/webhooks marked ★).
- Scaffold: tooling/infra copied from xtandard-webhooks and renamed (storage drivers, auth,
  authorization, adapters, server bits, UI infra, site, workflows).
- Next: spine (schema, ids, canonical, integrity, query, storage contract + memory, core, recorder).
