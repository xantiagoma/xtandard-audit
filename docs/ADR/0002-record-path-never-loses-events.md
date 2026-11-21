# ADR 0002 — The Record Path Never Loses Events Silently

**Status:** Accepted (★ deviation: replaces webhooks ADR 0002 "delivery-plane independence")

---

## Context

Like webhooks, an audit log has two very different workloads:

- **Control plane** — browsing, exporting and verifying logs, managing the action catalog, retention,
  checkpoints, streams. Rare, human-driven, guarded by auth, authorization, hooks.
- **Record plane** — `record()` inside the host's request handlers. Hot, machine-driven.

Webhooks' rule is "`publish()` never fails because a remote party is down". An audit log has the
opposite failure stance on the thing it owns: **dropping an audit event is a compliance incident**.
But it must also not turn a slow database into a slow product. These pull in different directions,
so we offer two explicit modes rather than one compromise.

## Decision

1. **`core.record(event)` / `core.recordMany(events)` are synchronous-commit**: they validate, apply
   transforms, chain (ADR 0004) and append, and resolve only after storage acknowledged the write.
   They **throw** on validation errors and on storage failure. Use them where the business operation
   and its audit event must succeed or fail together.
2. **`createRecorder(core, { batchSize, flushIntervalMs, maxQueue, retry, fallback, onError })`** is
   the fire-and-forget mode: `recorder.record()` validates synchronously (programmer errors throw
   immediately) and enqueues; batches flush per tenant with bounded exponential retry. When retries
   are exhausted the batch goes to the `fallback` sink (e.g. a local file / stderr JSONL) **and**
   `onError` is invoked; when there is no fallback the batch stays queued (bounded by `maxQueue`,
   past which `record()` throws `RecorderOverflowError`). `flush()` and `close()` drain for
   graceful shutdown; `pending` exposes depth. Nothing is ever dropped without a callback firing.
3. Streaming to SIEMs and sinks **reads from the log** (ADR 0008); it never sits on the record path.
4. The admin UI and viewer are optional at runtime: recording never depends on the panel.

## Consequences

- Hosts choose per call site: strict (`core.record`) or buffered (`recorder.record`).
- The buffered recorder is a single-process buffer: a hard crash (SIGKILL, OOM) can lose what is
  in memory. That is documented; hosts that cannot accept it use `core.record` or a durable
  `fallback`.
- Compare webhooks: same two-plane split, opposite failure stance on the owned resource.
