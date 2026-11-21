# siem-streaming × @xtandard/audit

Push the log — and its signed checkpoints — to a SIEM, to a customer's webhook
endpoint, and to an independent witness, while the app keeps recording.
Streams **read** the log by per-tenant cursors (ADR 0008): nothing sits on the
record path, and nothing is lost while a destination is down.

## What's here

| Stream     | Sink                                   | Scope                                                      |
| ---------- | -------------------------------------- | ---------------------------------------------------------- |
| `siem`     | `httpSink` → `POST /ingest` (JSON)     | every tenant, batches of 25                                |
| `customer` | `webhookSink` → `POST /webhook`        | tenant `acme`, minus `user.login`; Standard Webhooks-signed |
| `witness`  | `callbackSink` keeping checkpoints only | every tenant — signed chain heads stored outside the DB    |

- **`src/receiver.ts`** — one local server playing the SIEM intake and the
  customer's endpoint. The webhook route verifies every request with
  `verifyWebhook` from `@xtandard/webhooks/receiver`. Each route **fails its
  first 2 requests** with a 503.
- **`src/index.ts`** — records 40 events over ~3s while the runner (500ms
  ticks, `maxBackoff: "4s"`) streams them; prints lag as it grows and drains,
  then verifies an export of `acme` against the **witnessed** checkpoints
  rather than the bundle's own copies.

## Run it

```bash
bun install
bun run start
```

## What you'll see

```txt
  ← ingest  503 (failing request 1/2 on purpose)
  ✗ siem/acme: http sink: HTTP 503 — temporarily unavailable → backing off
  ← webhook 503 (failing request 1/2 on purpose)
→ recorded 10 events · lag siem=8 customer=7 witness=6
  ← ingest  200 acme: #1–#14 + 1 signed checkpoint
  …
  ← webhook 200 acme: #2–#30 + 3 signed checkpoints (signature verified)

Drained. Accepted by the SIEM: 44 items; by the customer webhook: 21 items; witnessed checkpoints: 4.
acme export vs witnessed checkpoints: VALID — 31 events, signed through #30
```

The cursor only advances after the destination accepted a batch: a failure
keeps it, backs off (1s, 2s, 4s … capped), and the next success catches up in
order. Delivery is at-least-once — receivers dedupe on the item id
(`event.id` / `checkpoint.id`; the webhook sink derives a stable `webhook-id`).
In the panel, the Streams view shows the same per-tenant `lag`, `failures` and
`lastError`; `POST /api/streams/:name/retry` clears a backoff.

Other sinks (`datadogSink`, `splunkSink`, `s3Sink`, `fileSink`, `consoleSink`,
and the `@xtandard/webhooks` bridge for tenant self-serve endpoints): see
[Streaming](../../docs/STREAMING.md).

## Files

- [`src/index.ts`](./src/index.ts) — the core, the three streams, the recording loop, the witness check.
- [`src/receiver.ts`](./src/receiver.ts) — the failing-then-healthy SIEM intake and verifying webhook endpoint.
