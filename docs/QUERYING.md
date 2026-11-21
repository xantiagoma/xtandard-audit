# Querying

One query shape everywhere — the core, the HTTP API, the UI, portal filters, exports and the CLI
([ADR 0007](ADR/0007-query-model-pagination.md)).

```ts
interface AuditQuery {
  tenant?: string; // forced for portal principals
  actions?: string[]; // exact names, or families: "invoice.*"
  excludeActions?: string[];
  actorId?: string;
  actorType?: string; // events without a type count as "user"
  targetType?: string;
  targetId?: string;
  outcome?: "success" | "failure";
  from?: string; // occurredAt >= from (ISO-8601)
  to?: string; // occurredAt <  to
  search?: string; // case-insensitive substring
  order?: "desc" | "asc"; // by (occurredAt, id); default newest first
  limit?: number; // default 50, max 500
  cursor?: string; // pageInfo.endCursor of the previous page
}
```

All filters are AND-ed; list filters are OR-ed within themselves. `search` matches the action, the actor's
id/name/email, every target's type/id/name, the description, and the JSON of `metadata`.

## Pagination

Keyset on `(occurredAt, id)`: the cursor is an opaque encoding of the last row, so pages stay stable while
new events arrive and cost an index seek on native drivers. There are no offsets and no totals by default
(`core.count(tenant)` is separate).

```ts
let cursor: string | undefined;
do {
  const page = await audit.query({ tenant: "acme", actions: ["member.*"], limit: 200, cursor });
  for (const event of page.items) handle(event);
  cursor = page.pageInfo.endCursor ?? undefined;
} while (cursor);
```

## With `@xtandard/lib`

The result is `@xtandard/lib`'s `Paginated<T>` envelope (`{ items, pageInfo: { hasNextPage, endCursor } }`),
so it plugs into its paginator and TanStack Query helpers without an adapter:

```ts
import { createPaginator } from "@xtandard/lib/pagination";

const paginator = createPaginator({
  fetchCursor: ({ limit, cursor }) => audit.query({ tenant, limit, cursor: cursor ?? undefined }),
});
```

## Over HTTP

The same fields as query parameters; lists repeat or use commas
(`GET /api/tenants/acme/events?actions=invoice.*,user.login&limit=100`). See [HTTP API](HTTP_API.md).

## How drivers execute it

Native drivers compile the query to their own language (SQL `WHERE` with a target join and a denormalized
lower-cased search column; Mongo filters with `$elemMatch`). The KV fallback picks the most selective index
(actor, target, single action, else time), walks it in order and filters in memory. The conformance suite
checks every driver against the reference matcher (`matchesQuery`).
