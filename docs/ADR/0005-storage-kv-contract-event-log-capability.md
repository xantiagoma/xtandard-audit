# ADR 0005 — Storage = KV Contract + Optional Native `EventLogStorage` Capability

**Status:** Accepted (★ deviation from webhooks ADR 0005 "KV contract + due index")

---

## Context

The siblings' promise is "point it at the database you already run": a four-method KV contract
(`getItem`, `setItem`, `removeItem`, `getKeys`) plus feature-detected capabilities ports to ten
backends almost mechanically. Webhooks added one queue capability (`claimDue`) for the delivery
work queue.

An audit log is **append-heavy and query-heavy**: millions of immutable rows per tenant, filtered by
actor, action, target, time range and free text, paginated. A pure KV scan (`getKeys(prefix)` then
filter in memory) is fine for development and small tenants but is O(events) per query. SQL and
document stores can do this natively with indexes.

Alternatives:

- **KV only** (siblings verbatim) — every driver ports, queries do not scale.
- **A new event-store contract only** — scales, but every driver (Cloudflare KV, unstorage, file)
  must implement a query engine, and we lose the sibling drivers' shape.
- **KV base + optional native capability** — exactly the webhooks pattern applied to the new need.

## Decision

1. Keep the four-method `AuditStorage` KV contract and the sibling capability set (`watch`,
   `transaction`, `compareAndSwap`) verbatim. Control data (catalog, chain heads, checkpoints,
   stream cursors, operator log) always lives in KV keys.
2. Add one optional capability, **`EventLogStorage`**:
   `appendEvents(tenant, events, { expectedSeq })`, `getEvent(tenant, id)`,
   `queryEvents(query)`, `eventsBySeq(tenant, { afterSeq, limit })`,
   `deleteEvents(tenant, { beforeSeq | before })`, `eraseSections(tenant, id, patch)`,
   `countEvents(tenant?)`. Drivers with indexes implement it natively: **memory, postgres, sqlite,
   libsql, mongodb, drizzle (pg/mysql/sqlite)**.
3. Everything else (**file, redis, unstorage, cloudflare-kv**) uses the generic fallback in the core:
   events stored under time-ordered keys plus secondary index keys (see `src/keys.ts`), queries
   choose the most selective index and filter in memory, keyset pagination on the key.
4. The conformance suite (`test/storage-contract.ts`) runs the KV contract **and** the event-log
   behaviour (through the native capability or the fallback) against every driver.

## Consequences

- All ten sibling drivers exist with the same factory names and options; native query is an
  efficiency + multi-writer-safety upgrade, not a requirement.
- Recommended production backends: Postgres / MySQL (Drizzle) / SQLite / libSQL / MongoDB. KV-only
  backends are documented as fine for small volumes, with retention.
- ClickHouse-class analytics stores are a future driver behind the same capability.
