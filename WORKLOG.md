# WORKLOG — `@xtandard/audit`

Reverse-chronological. Each entry: timestamp · task · files · tests · blocker · next.

---

## 2026-11-20 — research gate + design

- Research gate (worker `audit-research`): `docs/research/landscape.md`. Verdict: no permissive +
  maintained + embeddable-library equivalent (Retraced = heavy service, no release since 2024-11,
  per-event hash only; AuditKit = AGPL + proprietary ee; WorkOS/Pangea = SaaS; the rest are
  ORM/framework row-diff plugins). → build.
- Design: `PLAN.md` + ADRs 0001–0013 (deviations from flags/webhooks marked ★).
- Scaffold: tooling/infra copied from xtandard-webhooks and renamed (storage drivers, auth,
  authorization, adapters, server bits, UI infra, site, workflows).
- Next: spine (schema, ids, canonical, integrity, query, storage contract + memory, core, recorder).
