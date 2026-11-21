/**
 * Generic HTTP sink: POSTs each stream batch to a URL, as one JSON document
 * (`{ stream, tenant, items }`) or as NDJSON (one item per line). Any non-2xx
 * answer throws, so the stream runner keeps the cursor and backs off
 * (ADR 0008). Zero dependencies — uses the runtime's `fetch`.
 *
 * @module
 */

import type { AuditSink, StreamBatch } from "../streams.ts";
import { sendRequest, resolveHeaders, type SinkFetch, type SinkHeaders } from "./shared.ts";

export { SinkHttpError, type SinkFetch, type SinkHeaders } from "./shared.ts";

/** Options for {@link httpSink}. */
export interface HttpSinkOptions {
  /** Destination URL. */
  url: string;
  /** Extra headers (auth tokens…), static or resolved per batch. */
  headers?: SinkHeaders;
  /**
   * Body format:
   * - `"json"` (default) — `{ "stream", "tenant", "items": [...] }`, `application/json`;
   * - `"ndjson"` — one `StreamItem` JSON object per line, `application/x-ndjson`.
   */
  format?: "json" | "ndjson";
  /** HTTP method. Default `"POST"`. */
  method?: "POST" | "PUT";
  /** Request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Custom `fetch` (tests, proxies). Default `globalThis.fetch`. */
  fetch?: SinkFetch;
}

/** Serialize a batch for {@link httpSink}. */
export function encodeHttpBatch(batch: StreamBatch, format: "json" | "ndjson" = "json"): string {
  if (format === "ndjson") return batch.items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  return JSON.stringify({ stream: batch.stream, tenant: batch.tenant, items: batch.items });
}

/**
 * Create a generic HTTP sink.
 *
 * Delivery is at-least-once: a batch can arrive again after a timeout or a
 * crash between the 2xx and the cursor write. Receivers dedupe on
 * `item.event.id` / `item.checkpoint.id`.
 *
 * @example
 * ```ts
 * import { createStreamRunner } from "@xtandard/audit";
 * import { httpSink } from "@xtandard/audit/sinks/http";
 *
 * createStreamRunner(audit, {
 *   streams: [
 *     {
 *       name: "siem",
 *       sink: httpSink({
 *         url: "https://siem.example.com/ingest",
 *         headers: { authorization: `Bearer ${process.env.SIEM_TOKEN}` },
 *         format: "ndjson",
 *       }),
 *     },
 *   ],
 * }).start();
 * ```
 */
export function httpSink(options: HttpSinkOptions): AuditSink {
  const format = options.format ?? "json";
  if (format !== "json" && format !== "ndjson") {
    throw new TypeError(`httpSink: unknown format "${String(format)}"`);
  }
  const contentType = format === "json" ? "application/json" : "application/x-ndjson";
  return {
    kind: "http",
    async send(batch) {
      if (batch.items.length === 0) return;
      await sendRequest(
        "http",
        options.url,
        {
          method: options.method ?? "POST",
          headers: {
            "content-type": contentType,
            ...(await resolveHeaders(options.headers, batch)),
          },
          body: encodeHttpBatch(batch, format),
        },
        options,
      );
    },
  };
}
