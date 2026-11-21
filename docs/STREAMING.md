# Streaming

Push audit events — and signed checkpoints — to SIEMs, log platforms, archives and your
customers' own endpoints. Streaming **reads the log**; it never sits on the record path
([ADR 0002](./ADR/0002-record-path-never-loses-events.md), [ADR 0008](./ADR/0008-pull-based-streaming.md)).

## Concepts

The audit log is already a durable, ordered, per-tenant sequence: every event has a contiguous
`seq` in its tenant's hash chain. A stream therefore needs no queue of its own — only a
**position** in that sequence.

| Term       | What it is                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- |
| **stream** | `{ name, sink, filter?, tenants?, checkpoints?, batchSize?, startFrom? }`, declared in code    |
| **sink**   | a destination: `{ kind, send(batch), close?() }` — `send` resolves only once accepted          |
| **cursor** | one per stream per tenant: the last acknowledged `seq` (`aud/streams/{name}/cursors/{tenant}`) |
| **batch**  | `{ stream, tenant, items }` — up to `batchSize` items of **one** tenant, in `seq` order        |
| **item**   | `{ kind: "event", event }` or `{ kind: "checkpoint", checkpoint }`                             |
| **runner** | `createStreamRunner(core, { streams })` — ticks every `interval` and pumps every stream        |

```ts
import { createAuditCore, createStreamRunner } from "@xtandard/audit";
import { httpSink } from "@xtandard/audit/sinks/http";
import { s3Sink } from "@xtandard/audit/sinks/s3";

const runner = createStreamRunner(audit, {
  streams: [
    {
      name: "siem",
      sink: httpSink({ url: "https://siem.example.com/ingest", format: "ndjson" }),
      filter: { excludeActions: ["user.heartbeat"] },
    },
    {
      name: "archive",
      sink: s3Sink({ bucket: "audit-archive", region: "eu-west-1", accessKeyId, secretAccessKey }),
      startFrom: "beginning",
      batchSize: 1000,
    },
  ],
  interval: "2s",
  maxBackoff: "10m",
});
runner.start(); // timers are unref'ed; call runner.stop() on shutdown
```

The panel creates and starts a runner when given `streams` (pass `streams: false` to opt out);
`runner.tick()` runs one pass now (tests, cron-triggered workers).

### A tick

For each stream, for each tenant (all, or `tenants`):

1. read the cursor (a new cursor starts at the head with `startFrom: "now"` — the default — or
   before the first retained event with `"beginning"`);
2. skip the tenant while it is backing off (`nextAttemptAt` in the future);
3. read the next `batchSize` events with `eventsBySeq(tenant, { afterSeq: cursor })`, keep those
   matching `filter`, and append any checkpoint whose `seq` is now covered;
4. `await sink.send(batch)`;
5. on resolve, advance the cursor to the last **read** seq (filtered-out events are skipped, not
   re-read) and loop while full batches keep coming; on throw, keep the cursor and back off.

## Delivery semantics

- **At-least-once.** The cursor advances only after `send` resolved. A crash, timeout or failed
  cursor write between "the destination accepted it" and "the cursor moved" re-sends the batch.
  Every item carries a stable id (`event.id`, `checkpoint.id`): **dedupe on it**. Sinks help where
  the destination allows — the webhook sink derives a stable `webhook-id`, the
  `@xtandard/webhooks` bridge passes `idempotencyKey`, the S3 sink writes idempotent keys.
- **Ordered per tenant.** Batches of a tenant are sent one at a time, in `seq` order; a failing
  tenant blocks only itself. Across tenants there is no order (and none is needed).
- **Nothing is dropped.** A failure leaves the cursor where it is. Retention never prunes past the
  slowest cursor of a tenant (the runner registers a retention floor) unless you set
  `retention.ignoreStreams: true`. Events pruned before a stream ever saw them (a stream added
  after a prune with `startFrom: "beginning"`) are skipped from the retained base.
- **Filters are per stream.** `filter` takes the query model (`actions`, `excludeActions`,
  `actorId`, `targetType`, `outcome`, `from`/`to`, `search`, …; tenant and pagination fields are
  ignored).

## Backoff, lag and retries

A failed `send` stores on the cursor: `failures`, `lastError`, `lastErrorAt` and
`nextAttemptAt = now + min(maxBackoff, 1s × 2^(failures − 1))` — 1s, 2s, 4s … capped at
`maxBackoff` (default `"10m"`). The first success resets `failures` to 0. `onError` (default
`console.warn`) fires for every failure.

`runner.status()` (the admin UI's Streams view, `GET /api/streams`) reports per stream and tenant:
`cursor`, `headSeq`, **`lag`** (`headSeq − cursor`), `failures`, `lastError`, `nextAttemptAt`,
`lastDeliveredAt`. Alert on growing lag. `runner.retry(stream, tenant?)`
(`POST /api/streams/:name/retry`) clears the backoff so the next tick retries immediately.

Sinks throw `SinkHttpError` (`status`, `body`; the message carries a body snippet) for rejected
requests, so `lastError` tells you why — `datadog sink: HTTP 403 — Forbidden`.

## Multiple instances

Each stream takes a **lease** (`aud/streams/{name}/lease`, default `"30s"`) before pumping, via
`compareAndSwap` when the storage implements that capability (`isCompareAndSwap(storage)`; the
memory driver does) — run the runner in every instance and one of them streams at a time. On a
storage without CAS there is no lease: run streams in **one** process (the same posture
as the webhooks dispatcher on plain KV).

## Checkpoints as witness copies

With `checkpoints: true` (the default), every signed checkpoint ([ADR 0004](./ADR/0004-tamper-evidence-hash-chain-checkpoints.md))
is streamed as `{ kind: "checkpoint", checkpoint }` after the event it covers. Shipping signed
chain heads to a system you do not control (your SIEM, a customer's bucket) is what makes
tampering detectable after the fact: an attacker who rewrites history in your database cannot
also rewrite the copies. Verify a later export bundle against any witnessed checkpoint with
`@xtandard/audit/verify`.

## Sinks

Every sink is its own subpath; all but `s3` are zero-dependency. HTTP-based sinks share
`timeoutMs` (default 10 s; S3 30 s), `fetch` (inject for tests or proxies) and `headers` (static,
or `(batch) => headers` for rotating tokens).

### `sinks/http` — generic HTTP

```ts
import { httpSink } from "@xtandard/audit/sinks/http";

httpSink({
  url: "https://siem.example.com/ingest",
  headers: { authorization: `Bearer ${token}` },
  format: "json", // or "ndjson"
  method: "POST", // or "PUT"
});
```

- `json` (default): `{ "stream", "tenant", "items": [...] }`, `content-type: application/json`.
- `ndjson`: one `StreamItem` per line, `content-type: application/x-ndjson`.
- Any non-2xx throws → backoff.

### `sinks/webhook` — Standard Webhooks, signed

```ts
import { webhookSink } from "@xtandard/audit/sinks/webhook";

webhookSink({
  url: "https://hooks.example.com/audit",
  secret: process.env.AUDIT_WEBHOOK_SECRET!, // "whsec_…" — or [new, old] while rotating
  mode: "batch", // or "item": one request per event / checkpoint
});
```

| Header / field      | Value                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| body                | Standard Webhooks envelope `{ type, timestamp, data }`                                                        |
| `type` / `data`     | batch: `"audit.batch"` / `{ stream, tenant, items }`; item: `audit.<action>` or `audit.checkpoint` / the item |
| `timestamp`         | the (newest) item's time — a re-sent batch is byte-identical                                                  |
| `webhook-id`        | the item id for single items, else `bat_` + 32 hex of SHA-256(stream, tenant, item ids) — stable on re-send   |
| `webhook-timestamp` | unix seconds at send time                                                                                     |
| `webhook-signature` | `v1,` + base64 HMAC-SHA256 over `${id}.${timestamp}.${body}`, one entry per secret                            |

Verifiable by `@xtandard/webhooks/receiver`, Svix, and the official `standardwebhooks` libraries
(the test suite checks all three plus an independent implementation of the spec):

```ts
import { verifyWebhook } from "@xtandard/webhooks/receiver";

const envelope = await verifyWebhook(request, process.env.AUDIT_WEBHOOK_SECRET!);
// envelope.type === "audit.batch"; envelope.data.items
```

`signWebhook(secret, id, timestamp, body)` and `batchWebhookId(batch)` are exported for tooling.

### `sinks/xtandard-webhooks` — tenant self-serve endpoints

See [the bridge recipe](#recipe-tenant-self-serve-siem-endpoints-with-xtandardwebhooks) below.

```ts
import { xtandardWebhooksSink } from "@xtandard/audit/sinks/xtandard-webhooks";

xtandardWebhooksSink(webhooksCore, {
  applicationKey: (tenant) => `org_${tenant}`, // default: the tenant key; null skips the tenant
  eventType: (item) => (item.kind === "event" ? `audit.${item.event.action}` : "audit.checkpoint"),
  payload: (item) => (item.kind === "event" ? item.event : item.checkpoint), // default
});
```

### `sinks/datadog` — Datadog Logs

```ts
import { datadogSink } from "@xtandard/audit/sinks/datadog";

datadogSink({
  apiKey: process.env.DD_API_KEY!,
  site: "datadoghq.eu", // default "datadoghq.com"
  service: "xtandard-audit",
  hostname: "api-1",
  tags: ["env:prod"],
});
```

POSTs to `https://http-intake.logs.<site>/api/v2/logs` with `DD-API-KEY`. One log per item:

```json
{
  "ddsource": "xtandard-audit",
  "service": "xtandard-audit",
  "ddtags": "tenant:acme,stream:siem,kind:event,action:invoice.paid,env:prod",
  "message": "Ada invoice.paid invoice:inv_1",
  "status": "info",
  "timestamp": "2026-11-20T10:00:00.000Z",
  "audit": { "id": "evt_…", "tenant": "acme", "seq": 42, "action": "invoice.paid", "…": "…" }
}
```

`status` is `warn` for `outcome: "failure"`; `message` is the event's `description` when set
(override with `message`). Batches are split to the intake limits — 1000 logs and 5 MB per request
(`maxEntries` / `maxBytes` can only lower them). A single log above Datadog's 1 MB per-log limit is
truncated by Datadog. Facet on `@audit.actor.id`, `@audit.targets.id`, `@audit.tenant`.

### `sinks/splunk` — Splunk HTTP Event Collector

```ts
import { splunkSink } from "@xtandard/audit/sinks/splunk";

splunkSink({
  url: "https://splunk.example.com:8088", // "/services/collector/event" is appended
  token: process.env.SPLUNK_HEC_TOKEN!,
  index: "audit",
  host: "api-1",
  channel: "…", // when the HEC input uses indexer acknowledgement
});
```

`Authorization: Splunk <token>`; the body is HEC's batch format, one JSON object per item:
`{ time, host?, source: "xtandard-audit", sourcetype: "xtandard:audit", index?, fields, event }`,
`time` in epoch seconds with millisecond precision, `fields` (indexed) = `tenant`, `stream`,
`kind`, `action` (`fields: false` to omit). A 2xx whose JSON `code` is not `0` is a failure too.
Requests are split at `maxBytes` (default 1 MB).

### `sinks/s3` — S3-compatible archive (S3, R2, MinIO, B2)

```ts
import { s3Sink } from "@xtandard/audit/sinks/s3";

// Cloudflare R2 / MinIO: endpoint ⇒ path-style, region "auto"
s3Sink({
  bucket: "audit-archive",
  prefix: "prod/",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  accessKeyId,
  secretAccessKey,
});

// AWS with a prebuilt client (virtual-hosted URLs)
import { AwsClient } from "aws4fetch";
s3Sink({
  bucket: "audit",
  region: "eu-west-1",
  client: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "eu-west-1" }),
});
```

Requires the optional peer `aws4fetch` (`bun add aws4fetch`) unless you pass a `client` (anything
with a SigV4-signing `fetch(url, init)`). Layout:

```txt
{prefix}{tenant}/{yyyy}/{mm}/{dd}/{firstSeq}-{lastSeq}.jsonl   events, one per line (12-digit seqs)
{prefix}{tenant}/checkpoints/{checkpoint id}.json               one object per signed checkpoint
```

The date is the first event's `recordedAt` (UTC). Keys are deterministic, so a re-sent batch
overwrites itself; a retried batch that grew picks a new `lastSeq` and overlaps the previous
object — dedupe on `id` when loading. Uploads sign the payload's SHA-256 (not
`UNSIGNED-PAYLOAD`), so the store rejects a body altered in flight. Options: `region` (default
`us-east-1`, or `auto` with `endpoint`), `pathStyle`, `sessionToken`, `checkpoints: false`.

### `sinks/console` — stdout

```ts
import { consoleSink } from "@xtandard/audit/sinks/console";

consoleSink(); // [siem] acme #42 2026-11-20T10:00:00.000Z invoice.paid by Ada <user_1> → invoice:inv_1 evt_…
consoleSink({ format: "json" }); // {"stream":"siem","tenant":"acme","kind":"event","event":{…}}
```

### `sinks/file` — JSONL file + recorder fallback

```ts
import { fileFallback, fileSink, readFallbackLines } from "@xtandard/audit/sinks/file";

fileSink({ path: (batch) => `/var/lib/app/audit/${batch.tenant}.jsonl` }); // one StreamItem per line

// The buffered recorder's last resort (ADR 0002): park batches storage refused.
const recorder = createRecorder(audit, {
  fallback: fileFallback("/var/lib/app/audit-fallback.jsonl"),
});
// Later: replay
const lines = readFallbackLines(await readFile("/var/lib/app/audit-fallback.jsonl", "utf8"));
await audit.recordMany(lines.map((l) => l.input));
```

Both append with `node:fs` and `fsync` before resolving (`fsync: false` to skip). Fallback lines
are `{ at, error, input }`.

### Your own sink

```ts
import { callbackSink, type AuditSink } from "@xtandard/audit";

const kafka: AuditSink = {
  kind: "kafka",
  async send(batch) {
    await producer.send({
      topic: "audit",
      messages: batch.items.map((item) => ({
        key: item.kind === "event" ? item.event.id : item.checkpoint.id,
        value: JSON.stringify(item),
      })),
    }); // throw on failure → backoff; resolve only once accepted
  },
};

const quick = callbackSink(async (batch) => myQueue.push(batch));
```

## Recipe: tenant self-serve SIEM endpoints with `@xtandard/webhooks`

Operator-level streams (your SIEM, your archive) are declared in code. When **customers** want to
add their own endpoints — their Splunk, their Datadog, a Lambda — with a UI, retries,
dead-letters, replay and per-endpoint secrets, do not build that here: bridge to
[`@xtandard/webhooks`](https://github.com/xantiagoma/xtandard-webhooks) (ADR 0008 §6).

```ts
import { createWebhooksCore, createDispatcher } from "@xtandard/webhooks";
import { createStreamRunner } from "@xtandard/audit";
import { xtandardWebhooksSink } from "@xtandard/audit/sinks/xtandard-webhooks";

const webhooks = createWebhooksCore({ storage: webhooksStorage });

// One webhooks application per audit tenant (create it when the customer enables streaming).
await webhooks.createApplication({ key: "acme" });
// requireKnownEventTypes is on by default: register what you stream.
for (const name of ["audit.invoice.paid", "audit.member.role_changed", "audit.checkpoint"]) {
  await webhooks.upsertEventType({ name, description: "Audit log event" });
}

createStreamRunner(audit, {
  streams: [
    {
      name: "tenant-webhooks",
      sink: xtandardWebhooksSink(webhooks, {
        // Only tenants that turned streaming on; others are skipped (cursor still advances).
        applicationKey: async (tenant) => ((await isStreamingEnabled(tenant)) ? tenant : null),
      }),
    },
  ],
}).start();

createDispatcher(webhooks).start(); // or the webhooks panel, which starts one
```

Then mount the webhooks **portal** for each tenant: customers add endpoints, pick event types
(`audit.*`), rotate secrets and inspect deliveries; their receivers verify with any Standard
Webhooks library. Each audit item becomes one webhooks message with
`idempotencyKey = event.id / checkpoint.id`, so a re-sent batch is deduplicated by the webhooks
core; a re-publish whose payload changed since (the event was erased, ADR 0011) is treated as
delivered. A missing application throws (and the stream backs off) — return `null` from
`applicationKey` for tenants without one.
