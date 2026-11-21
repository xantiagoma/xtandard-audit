# ADR 0010 — Time-Sortable Event Ids

**Status:** Accepted (★ deviation: webhooks ids are 128-bit random base62)

---

## Context

Webhooks ids (`msg_…`, `ep_…`) are random: nothing sorts by id. Audit events are listed by time
constantly, used as keyset tie-breakers, and as KV index keys where lexicographic order must equal
chronological order.

## Decision

Event ids are `evt_` + a 26-character Crockford base32 ULID-style value: 48-bit unix milliseconds +
80 random bits, **monotonic within a process** (same millisecond → increment the random part).
Zero dependencies. Other entities keep the sibling scheme where they exist (`chk_` checkpoints use
the same generator for ordering).

## Consequences

- `id` order ≈ `recordedAt` order; `(occurredAt, id)` is a total, stable sort key.
- Ids leak creation time — acceptable (the event carries its timestamps anyway).
- Hosts can supply their own `id` (idempotent re-record: same id + same content is a no-op).
