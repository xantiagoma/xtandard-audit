/**
 * Standard Webhooks sink: POSTs each stream batch (or each item) as a signed
 * [Standard Webhooks](https://www.standardwebhooks.com) message, verifiable by
 * `@xtandard/webhooks/receiver`, Svix, the official `standardwebhooks`
 * libraries, or any compliant receiver.
 *
 * Wire contract:
 *
 * - body: the Standard Webhooks envelope `{ "type", "timestamp", "data" }`;
 *   - `mode: "batch"` (default): `type` = `"audit.batch"`, `data` = `{ stream, tenant, items }`;
 *   - `mode: "item"`: one request per item, `type` = `"audit.<action>"` /
 *     `"audit.checkpoint"`, `data` = the event / checkpoint;
 * - `webhook-id`: the event / checkpoint id for single items, otherwise a
 *   deterministic `bat_…` id derived from the batch's item ids — a re-sent
 *   batch keeps its id, so receivers can dedupe on it;
 * - `webhook-timestamp`: unix seconds at send time;
 * - `webhook-signature`: `v1,` + base64(HMAC-SHA256(base64-decoded `whsec_`
 *   secret, `${id}.${timestamp}.${body}`)); several space-separated entries
 *   when several secrets are configured (rotation).
 *
 * Zero dependencies — Web Crypto + `fetch`.
 *
 * @module
 */

import type { AuditSink, StreamBatch, StreamItem } from "../streams.ts";
import {
  defaultItemType,
  itemId,
  itemTime,
  resolveHeaders,
  sendRequest,
  type SinkFetch,
  type SinkHeaders,
} from "./shared.ts";

export { SinkHttpError, type SinkFetch, type SinkHeaders } from "./shared.ts";

/** Prefix of a Standard Webhooks symmetric secret. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;

/** Options for {@link webhookSink}. */
export interface WebhookSinkOptions {
  /** Receiver URL. */
  url: string;
  /**
   * `whsec_…` secret(s). Pass several during rotation: the request carries one
   * signature per secret and receivers accept any match.
   */
  secret: string | string[];
  /** `"batch"` (default): one request per batch. `"item"`: one request per event / checkpoint. */
  mode?: "batch" | "item";
  /** Envelope `type` for batch mode. Default `"audit.batch"`. */
  batchType?: string;
  /** Envelope `type` for item mode. Default `audit.<action>` / `audit.checkpoint`. */
  itemType?: (item: StreamItem) => string;
  /** Extra headers, static or resolved per batch. */
  headers?: SinkHeaders;
  /** Request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Custom `fetch` (tests, proxies). Default `globalThis.fetch`. */
  fetch?: SinkFetch;
  /** Clock (unix millis) for `webhook-timestamp`. Default `Date.now`. */
  now?: () => number;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode a `whsec_` secret into key bytes (24–64 bytes, as Standard Webhooks requires). */
function decodeSecret(secret: string): Uint8Array {
  const body = secret.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secret.slice(WEBHOOK_SECRET_PREFIX.length)
    : secret;
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new TypeError("webhookSink: secret is not valid base64 (expected whsec_…)");
  }
  if (binary.length < MIN_SECRET_BYTES || binary.length > MAX_SECRET_BYTES) {
    throw new TypeError(
      `webhookSink: secret decodes to ${binary.length} bytes, expected ${MIN_SECRET_BYTES}–${MAX_SECRET_BYTES}`,
    );
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Sign one message: `v1,` + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)).
 * `timestamp` is unix **seconds**.
 *
 * @example
 * ```ts
 * import { signWebhook } from "@xtandard/audit/sinks/webhook";
 *
 * const signature = await signWebhook("whsec_…", "evt_…", 1_720_000_000, body); // "v1,…"
 * ```
 */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSecret(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${base64Encode(new Uint8Array(mac))}`;
}

/**
 * The `webhook-id` of a batch: the item's own id when there is exactly one,
 * otherwise `bat_` + a SHA-256 prefix over the stream, tenant and item ids —
 * stable across re-sends of the same batch.
 */
export async function batchWebhookId(batch: StreamBatch): Promise<string> {
  if (batch.items.length === 1) return itemId(batch.items[0]!);
  const seed = [batch.stream, batch.tenant, ...batch.items.map(itemId)].join("\n");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  return `bat_${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Create a Standard Webhooks-signed sink.
 *
 * For per-tenant self-serve endpoints (customers adding their own SIEM URLs,
 * with a portal, retries and dead-letters), use the `@xtandard/webhooks`
 * bridge instead: `@xtandard/audit/sinks/xtandard-webhooks`.
 *
 * @example
 * ```ts
 * import { webhookSink } from "@xtandard/audit/sinks/webhook";
 *
 * const sink = webhookSink({
 *   url: "https://hooks.example.com/audit",
 *   secret: process.env.AUDIT_WEBHOOK_SECRET!, // "whsec_…"
 * });
 * ```
 */
export function webhookSink(options: WebhookSinkOptions): AuditSink {
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret];
  if (secrets.length === 0) throw new TypeError("webhookSink: at least one secret is required");
  for (const s of secrets) decodeSecret(s); // fail fast on misconfiguration
  const mode = options.mode ?? "batch";
  const now = options.now ?? Date.now;
  const itemType = options.itemType ?? defaultItemType;

  async function post(
    batch: StreamBatch,
    id: string,
    envelope: { type: string; timestamp: string; data: unknown },
  ): Promise<void> {
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(now() / 1000);
    const signatures = await Promise.all(secrets.map((s) => signWebhook(s, id, timestamp, body)));
    await sendRequest(
      "webhook",
      options.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await resolveHeaders(options.headers, batch)),
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signatures.join(" "),
        },
        body,
      },
      options,
    );
  }

  return {
    kind: "webhook",
    async send(batch) {
      if (batch.items.length === 0) return;
      if (mode === "item") {
        for (const item of batch.items) {
          await post(batch, itemId(item), {
            type: itemType(item),
            timestamp: itemTime(item),
            data: item.kind === "event" ? item.event : item.checkpoint,
          });
        }
        return;
      }
      await post(batch, await batchWebhookId(batch), {
        type: options.batchType ?? "audit.batch",
        // The newest item's time (not "now"): a re-sent batch is byte-identical.
        timestamp: itemTime(batch.items[batch.items.length - 1]!),
        data: { stream: batch.stream, tenant: batch.tenant, items: batch.items },
      });
    },
  };
}
