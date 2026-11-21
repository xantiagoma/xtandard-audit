# ADR 0013 — Request Context Capture via AsyncLocalStorage Middleware

**Status:** Accepted (★ new; pattern borrowed from drizzle-audit)

---

## Context

Every audit event wants the same request context: actor, IP, user agent, request id, sometimes
tenant. Threading it through every call site is noisy and error-prone. `drizzle-audit` solved this
with an AsyncLocalStorage context and per-framework middleware.

## Decision

1. `@xtandard/audit/context` exports `runWithAuditContext(ctx, fn)`, `getAuditContext()`,
   `setAuditContext(patch)` (enterWith-style) and `auditContextFromRequest(request, opts)` (IP from
   `x-forwarded-for`/`cf-connecting-ip`/`x-real-ip` behind a `trustProxy` switch, user agent,
   `x-request-id`). It uses `node:async_hooks` (Bun, Node, Deno, Cloudflare Workers with
   `nodejs_compat`).
2. `core.record()` merges the ambient context under explicit input (explicit wins) when the core is
   created with `context: true` (default) — the hot path stays one call.
3. Each framework adapter subpath exports, next to `auditPanel`, an `auditContext({ actor, tenant })`
   middleware that resolves the actor/tenant from the host's own auth and opens the scope.

## Consequences

- One line of middleware gives every event IP/UA/request id/actor attribution.
- Runtimes without AsyncLocalStorage still work by passing `context` explicitly.
