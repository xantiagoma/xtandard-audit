# ADR 0003 — Bundled SPA UI and React Embeds

**Status:** Accepted (mirrors `@xtandard/flags` ADR 0003 and `@xtandard/webhooks` ADR 0003)

---

## Context

Operators need an admin UI (all tenants, action catalog, streams, retention, integrity), and each
tenant's users need a **customer-facing portal** (log viewer) inside the host product (browse, filter,
export, verify). The siblings proved the shape: a prebuilt SPA served by the package's fetch handler,
plus React components for hosts that want it inside their own tree.

## Decision

Bundle a prebuilt React SPA (React 19, Tailwind v4, TanStack Query, wouter) into `dist/ui`, served
by `createFetchHandler` with `__AUDIT_CONFIG__` and `<base>` injection. The same bundle renders two
chromes: the full **admin dashboard**, and the reduced **portal** chrome when `/config` reports a
portal-token principal (ADR 0006) — no second SPA.

A separate ESM React build (`@xtandard/audit/react`) exposes `<AuditDashboard>` and
`<AuditPortal>`; React is an optional peer there, styles are scoped (`react/styles.css`), and the
embeds follow the sibling theme contract (`theme="auto" | "inherit" | "light" | "dark"`).

## Consequences

- `bun add @xtandard/audit` + one mount line yields the admin UI in Elysia/Hono/Express/Bun.
- Same tokens, primitives and look as flags/webhooks — one product line.
