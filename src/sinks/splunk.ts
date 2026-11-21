/**
 * Splunk sink: ships events and checkpoints to the
 * [HTTP Event Collector](https://docs.splunk.com/Documentation/Splunk/latest/Data/HECRESTendpoints)
 * (`POST <url>/services/collector/event`, `Authorization: Splunk <token>`).
 *
 * The body is HEC's batch format — concatenated JSON objects, one per item:
 * `{ time, host?, source, sourcetype: "xtandard:audit", index?, fields, event }`
 * where `time` is the item's epoch seconds (millisecond precision) and
 * `event` is the full audit event (or checkpoint). Zero dependencies.
 *
 * @module
 */

import type { AuditSink, StreamBatch, StreamItem } from "../streams.ts";
import {
  SinkHttpError,
  chunkSerialized,
  itemTime,
  resolveHeaders,
  sendRequest,
  type SinkFetch,
  type SinkHeaders,
} from "./shared.ts";

export { SinkHttpError, type SinkFetch, type SinkHeaders } from "./shared.ts";

/** Options for {@link splunkSink}. */
export interface SplunkSinkOptions {
  /**
   * HEC base URL, e.g. `https://splunk.example.com:8088` (the
   * `/services/collector/event` path is appended unless already present).
   */
  url: string;
  /** HEC token (`Authorization: Splunk <token>`). */
  token: string;
  /** Target index (default: the token's default index). */
  index?: string;
  /** `host` field. */
  host?: string;
  /** `source` field. Default `"xtandard-audit"`. */
  source?: string;
  /** `sourcetype` field. Default `"xtandard:audit"`. */
  sourcetype?: string;
  /**
   * Add indexed `fields` (`tenant`, `stream`, `kind`, `action`). Default `true`.
   * Disable if your HEC input rejects indexed fields.
   */
  fields?: boolean;
  /** `X-Splunk-Request-Channel` (required when the HEC input has indexer acknowledgement on). */
  channel?: string;
  /** Max bytes per request; larger batches are split. Default 1 MB. */
  maxBytes?: number;
  /** Extra headers, static or resolved per batch. */
  headers?: SinkHeaders;
  /** Request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Custom `fetch` (tests, proxies). Default `globalThis.fetch`. */
  fetch?: SinkFetch;
}

/** Map one item to a HEC event object. */
export function toSplunkEvent(
  item: StreamItem,
  batch: StreamBatch,
  options: Pick<SplunkSinkOptions, "index" | "host" | "source" | "sourcetype" | "fields"> = {},
): Record<string, unknown> {
  return {
    time: Date.parse(itemTime(item)) / 1000,
    ...(options.host ? { host: options.host } : {}),
    source: options.source ?? "xtandard-audit",
    sourcetype: options.sourcetype ?? "xtandard:audit",
    ...(options.index ? { index: options.index } : {}),
    ...(options.fields === false
      ? {}
      : {
          fields: {
            tenant: batch.tenant,
            stream: batch.stream,
            kind: item.kind,
            ...(item.kind === "event" ? { action: item.event.action } : {}),
          },
        }),
    event: item.kind === "event" ? item.event : item.checkpoint,
  };
}

/** Resolve the HEC event endpoint from a base URL. */
function eventEndpoint(url: string): string {
  if (/\/services\/collector(\/event)?(\/1\.0)?\/?$/.test(url)) return url;
  return `${url.replace(/\/+$/, "")}/services/collector/event`;
}

/**
 * Create a Splunk HEC sink. A 2xx whose JSON body carries a non-zero `code`
 * is treated as a failure too.
 *
 * @example
 * ```ts
 * import { splunkSink } from "@xtandard/audit/sinks/splunk";
 *
 * const sink = splunkSink({
 *   url: "https://splunk.example.com:8088",
 *   token: process.env.SPLUNK_HEC_TOKEN!,
 *   index: "audit",
 * });
 * ```
 */
export function splunkSink(options: SplunkSinkOptions): AuditSink {
  if (!options.token) throw new TypeError("splunkSink: token is required");
  const url = eventEndpoint(options.url);
  const maxBytes = options.maxBytes ?? 1024 * 1024;

  return {
    kind: "splunk",
    async send(batch) {
      if (batch.items.length === 0) return;
      const events = batch.items.map((item) => JSON.stringify(toSplunkEvent(item, batch, options)));
      const extra = await resolveHeaders(options.headers, batch);
      for (const chunk of chunkSerialized(events, { maxEntries: Infinity, maxBytes })) {
        const response = await sendRequest(
          "splunk",
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...extra,
              ...(options.channel ? { "x-splunk-request-channel": options.channel } : {}),
              authorization: `Splunk ${options.token}`,
            },
            body: chunk.join("\n"),
          },
          options,
        );
        const text = await response.text().catch(() => "");
        let code = 0;
        try {
          code = (JSON.parse(text) as { code?: number }).code ?? 0;
        } catch {
          // Not JSON: a 2xx is success.
        }
        if (code !== 0) throw new SinkHttpError("splunk", response.status, text);
      }
    },
  };
}
