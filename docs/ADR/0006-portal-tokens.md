# ADR 0006 — Portal Tokens: Stateless HMAC, Tenant-Scoped, Optional View Filter

**Status:** Accepted (mirrors webhooks ADR 0006 "portal tokens"; ★ adds a server-side view filter)

---

## Context

The customer-facing portal lets each tenant's users browse, filter, export and verify **their own**
events inside the host product (the WorkOS "Log Streams / Audit Logs viewer" experience). Webhooks
solved the identical problem for its consumer portal with signed, expiring, application-scoped bearer
tokens: no sessions, no proxy routes; the host mints a token after its own auth.

Audit adds one need: hosts often hide some events from customers (internal support or operator-only
actions) or narrow a portal to a subset (e.g. a member sees only their own actions).

## Decision

Mirror webhooks, with names kept identical where the concept is identical:
`createPortalToken(secret, tenant, { expiresIn, filter })` produces
`audpt_` + base64url(`{ tenant, exp, filter? }`) + `.` + base64url(HMAC-SHA256(secret, payload)),
verified statelessly (signature first, constant time, then expiry) by the panel configured with
`portal: { secret, allow? }`. Default expiry `"1h"` (★ shorter than webhooks' `"7d"`: an audit portal
is a read session, not integration setup).

- **Force-scoped and closed**: only the token's tenant, only actions in `portal.allow` (default
  `DEFAULT_PORTAL_ACTIONS`: `event:read`, `event:export`, `action:read`, `integrity:read`). The host's
  authorization provider is **not** consulted for portal principals — portal scoping wins.
- ★ **Optional `filter`** (`actions`, `actionPrefixes`, `excludeActions`, `actorId`, `targetType`,
  `targetId`) is AND-ed into every query, export and count server-side; the client cannot widen it.
- Portal exports are recorded into the tenant's own log as `audit_log.exported` (self-audit), with
  the portal principal as actor.

Same SPA, reduced chrome (ADR 0003); `<AuditPortal apiBaseUrl token />` in `@xtandard/audit/react`.

## Consequences

- Two lines for hosts: mint a token in a route handler, render `<AuditPortal token={…} />`.
- Tokens are bearer credentials; revocation before expiry = rotate the portal secret.
- Integrity verification is available to portal principals, so customers can check their own log.
