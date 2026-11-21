# ADR 0008 — Streaming: Pull-Based Sinks with Per-Tenant Sequence Cursors

**Status:** Accepted (★ deviation: webhooks pushes through a due-index work queue)

---

## Context

Customers and operators want audit events pushed to SIEMs and archives: generic HTTP, signed
webhooks, Datadog, Splunk HEC, S3-compatible object stores. Webhooks delivers with a persisted
per-delivery work queue (due index, leases, retries, dead-letters) because each message fans out to
many independent endpoints with independent fates.

The audit log already **is** a durable, ordered, per-tenant sequence (ADR 0004: contiguous `seq`).
A stream does not need its own queue: it needs a position in that sequence.

## Decision

1. A **stream** is `{ name, sink, filter?, tenants?, batchSize, retry }`, declared in code
   (`streams: [...]` on the core / panel / CLI env).
2. The **stream runner** (`createStreamRunner(core)`, started by the panel like the webhooks
   dispatcher, `streams: false` to opt out) keeps one cursor per stream per tenant
   (`aud/streams/{name}/cursors/{tenant}` = last acknowledged `seq`), reads the next batch with
   `eventsBySeq(tenant, afterSeq)`, applies the filter, calls `sink.send(batch)`, and advances the
   cursor only after the sink resolved. At-least-once; sinks dedupe on `event.id`.
3. Failures back off exponentially per (stream, tenant) and surface in the admin UI (lag, last
   error, next retry). Nothing is dropped: the cursor simply does not advance. Retention never
   prunes past the slowest stream's cursor unless `retention.ignoreStreams` is set.
4. Checkpoints are streamed too (`{ kind: "checkpoint" }` items), so tenants can keep signed heads
   (ADR 0004).
5. Multi-instance: the runner takes a per-stream lease (`compareAndSwap` when available; otherwise
   run streams in one process — the same posture as the webhooks dispatcher on plain KV).
6. Per-tenant **self-serve** streaming (customers adding their own SIEM endpoints) is delegated to
   `@xtandard/webhooks` through the `xtandardWebhooksSink(core, …)` bridge: each tenant manages
   endpoints in the webhooks portal, with retries and dead-letters, instead of us rebuilding that.

## Consequences

- Zero extra writes on the record path; streaming load is proportional to new events.
- Ordering per tenant is guaranteed; across tenants it is not (and is not needed).
- The per-tenant cursor scan is O(tenants) per tick — the same scale posture as webhooks' per-app
  due scan; a global sequence is a later optimization if needed.
