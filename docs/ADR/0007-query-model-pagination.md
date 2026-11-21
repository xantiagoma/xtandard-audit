# ADR 0007 — Query Model and Keyset Pagination; No Runtime Dependency on `@xtandard/lib`

**Status:** Accepted (★ new; siblings have only `limit` + `before` listing)

---

## Context

Webhooks lists messages with `{ limit, before }` and in-memory filtering — enough for a delivery
inspector. An audit log's primary job is search: by actor, action (and action families), target,
tenant, time range, outcome and free text, over large volumes, in a stable order while new events
keep arriving.

`@xtandard/lib` offers a generic filter AST (`@xtandard/lib/filters`, field → kind allow-lists,
per-driver renderers) and a source-agnostic paginator (`@xtandard/lib/pagination`). The siblings are
independent packages (flags and webhooks depend only on `valibot` + `wouter`).

## Decision

1. A **fixed, typed query** — the audit schema is known, so a generic AST buys nothing:

   ```ts
   interface AuditQuery {
     tenant?: string; // required for portal principals (forced)
     actions?: string[]; // exact names; "invoice.*" = prefix family
     excludeActions?: string[];
     actorId?: string;
     actorType?: string;
     targetType?: string;
     targetId?: string;
     outcome?: "success" | "failure";
     from?: string;
     to?: string; // occurredAt range, ISO-8601, [from, to)
     search?: string; // case-insensitive substring over action, actor,
     // targets, description, metadata (driver-specific)
     order?: "desc" | "asc"; // by (occurredAt, id); default "desc"
     limit?: number; // default 50, max 500
     cursor?: string; // opaque keyset cursor
   }
   ```

2. **Keyset pagination on `(occurredAt, id)`**: the cursor is an opaque base64url of the last row's
   key; stable while new events arrive, O(log n) on indexed drivers. No offsets, no totals by
   default (`count` is a separate, optional call).
3. The result is **`@xtandard/lib`-compatible** without importing it:
   `{ items, pageInfo: { hasNextPage, endCursor } }` — the `Paginated<T>` envelope — so a host can
   feed `core.query` straight into `createPaginator({ fetchCursor })` or the lib's TanStack helpers.
4. **No runtime dependency on `@xtandard/lib`.** Its filter AST and paginator are generic tools for
   arbitrary resources; here each driver compiles the fixed query natively (SQL `WHERE` + index,
   Mongo filter, KV index scan). Taking the dependency would add install weight to every consumer
   for an abstraction we would immediately specialize away. The docs show the interop recipe.

## Consequences

- One query shape across the core, HTTP API (`?actions=…&actorId=…&cursor=…`), UI, portal filter,
  export and CLI.
- Free-text search is substring-based (SQL `LIKE`/`ILIKE` over a denormalized search column, Mongo
  regex, KV in-memory). Full-text engines are out of scope; a stream sink to a SIEM covers that.
