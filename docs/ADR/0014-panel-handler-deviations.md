# ADR 0014 — Panel Handler Deviations from the Siblings

**Status:** Accepted (★ small deviations from webhooks' `createFetchHandler`, collected in one place)

---

## Context

The panel handler, routes, auth, authorization and adapters are ported from `@xtandard/webhooks` and
keep its option names and shapes. A few behaviours differ because the audit domain differs.

## Decision

1. **Readonly answers `423 Locked`** (webhooks: `403`). A readonly audit panel still serves reads and
   exports; `423` tells clients the resource is frozen, not that they lack permission.
2. **The handler result has `streams` and `close()`** in place of webhooks' `dispatcher`. With
   `streamRunner: false` the runner is still created (not started) when `streams` are configured, so a
   split deployment's panel shows lag and can retry; `close()` stops the runner and the maintenance timer.
3. **`maintenance: { interval } | false`** (new): the panel runs `core.prune()` periodically (default
   `1h`, timer `unref`ed) when the core has a retention policy and the panel is not readonly.
4. **Streaming responses everywhere**: the Express adapter and the CLI's Node bridge stream bodies
   (webhooks buffers), because exports can be large.
5. **Roles preset** is `admin` / `auditor` / `viewer` (webhooks: admin / editor / viewer): an auditor
   reads, exports and verifies but cannot erase, prune or edit the catalog.
6. **No public catalog route** (webhooks' `/api/event-types.json`); the public routes are the OpenAPI
   document and the JWKS (`/api/integrity/keys`, CORS `*`, cacheable).
7. **CLI drivers and sinks load by subpath** (`STORAGE_DRIVER`, `AUDIT_STREAMS` JSON), resolved
   lazily so a missing optional peer is an actionable runtime error.

## Consequences

- Operators reading the webhooks docs find the same shape with these documented differences
  (docs/ADAPTERS.md, docs/DEPLOYMENT.md, docs/HTTP_API.md).
