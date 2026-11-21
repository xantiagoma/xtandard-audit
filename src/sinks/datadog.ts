/**
 * Datadog sink: ships events and checkpoints to the
 * [Logs intake API v2](https://docs.datadoghq.com/api/latest/logs/#send-logs)
 * (`POST https://http-intake.logs.<site>/api/v2/logs`, `DD-API-KEY`).
 *
 * Each item becomes one log: `ddsource`, `service`, `hostname`, `ddtags`
 * (`tenant:…`, `action:…`, `stream:…`, `kind:…` + your tags), a readable
 * `message`, `status` (`warn` for `outcome: "failure"`), `timestamp`, and the
 * full event (or checkpoint) under the `audit` attribute. Batches are split to
 * respect the intake limits (1000 logs and 5 MB per request). Zero
 * dependencies.
 *
 * @module
 */

import type { AuditSink, StreamBatch, StreamItem } from "../streams.ts";
import {
  chunkSerialized,
  itemTime,
  resolveHeaders,
  sendRequest,
  type SinkFetch,
  type SinkHeaders,
} from "./shared.ts";

export { SinkHttpError, type SinkFetch, type SinkHeaders } from "./shared.ts";

/** Datadog intake limit: logs per request. */
export const DATADOG_MAX_ENTRIES = 1000;
/** Datadog intake limit: uncompressed bytes per request. */
export const DATADOG_MAX_BYTES = 5 * 1024 * 1024;

/** Options for {@link datadogSink}. */
export interface DatadogSinkOptions {
  /** Datadog API key (`DD-API-KEY`). */
  apiKey: string;
  /**
   * Datadog site: `"datadoghq.com"` (default), `"datadoghq.eu"`,
   * `"us3.datadoghq.com"`, `"us5.datadoghq.com"`, `"ap1.datadoghq.com"`, `"ddog-gov.com"`.
   */
  site?: string;
  /** Full intake URL override (proxies, tests). Default `https://http-intake.logs.<site>/api/v2/logs`. */
  url?: string;
  /** `service` attribute. Default `"xtandard-audit"`. */
  service?: string;
  /** `ddsource` attribute. Default `"xtandard-audit"`. */
  source?: string;
  /** `hostname` attribute. */
  hostname?: string;
  /** Extra tags appended to every log (`"env:prod"`, `"team:security"`). */
  tags?: string[];
  /** Override the `message` of each log. */
  message?: (item: StreamItem) => string;
  /** Extra headers, static or resolved per batch. */
  headers?: SinkHeaders;
  /** Request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Custom `fetch` (tests, proxies). Default `globalThis.fetch`. */
  fetch?: SinkFetch;
  /** Max logs per request (≤ 1000). */
  maxEntries?: number;
  /** Max uncompressed bytes per request (≤ 5 MB). */
  maxBytes?: number;
}

/** A tag value: Datadog tags are comma-separated `key:value` pairs (no commas or spaces inside). */
function tagValue(value: string): string {
  return value.replace(/[,\s]+/g, "_");
}

/** The default human-readable `message` of an item. */
export function defaultLogMessage(item: StreamItem): string {
  if (item.kind === "checkpoint") {
    const cp = item.checkpoint;
    return `audit checkpoint ${cp.tenant} #${cp.seq} ${cp.hash}`;
  }
  const e = item.event;
  if (e.description) return e.description;
  const actor = e.actor.name ?? e.actor.email ?? e.actor.id;
  const targets = e.targets.map((t) => `${t.type}:${t.name ?? t.id}`).join(", ");
  return `${actor} ${e.action}${targets ? ` ${targets}` : ""}${e.outcome === "failure" ? " (failed)" : ""}`;
}

/** Map one item to a Datadog log object. */
export function toDatadogLog(
  item: StreamItem,
  batch: StreamBatch,
  options: Pick<DatadogSinkOptions, "service" | "source" | "hostname" | "tags" | "message"> = {},
): Record<string, unknown> {
  const tags = [
    `tenant:${tagValue(batch.tenant)}`,
    `stream:${tagValue(batch.stream)}`,
    `kind:${item.kind}`,
    ...(item.kind === "event"
      ? [
          `action:${tagValue(item.event.action)}`,
          ...(item.event.outcome ? [`outcome:${item.event.outcome}`] : []),
        ]
      : []),
    ...(options.tags ?? []),
  ];
  return {
    ddsource: options.source ?? "xtandard-audit",
    service: options.service ?? "xtandard-audit",
    ...(options.hostname ? { hostname: options.hostname } : {}),
    ddtags: tags.join(","),
    message: (options.message ?? defaultLogMessage)(item),
    status: item.kind === "event" && item.event.outcome === "failure" ? "warn" : "info",
    timestamp: itemTime(item),
    audit: item.kind === "event" ? item.event : item.checkpoint,
  };
}

/**
 * Create a Datadog Logs sink.
 *
 * A batch larger than the intake limits is sent as several requests, in
 * order; if one fails the whole batch is retried (at-least-once — dedupe on
 * `audit.id` in a Datadog pipeline if duplicates matter).
 *
 * @example
 * ```ts
 * import { datadogSink } from "@xtandard/audit/sinks/datadog";
 *
 * const sink = datadogSink({
 *   apiKey: process.env.DD_API_KEY!,
 *   site: "datadoghq.eu",
 *   tags: ["env:prod"],
 * });
 * ```
 */
export function datadogSink(options: DatadogSinkOptions): AuditSink {
  if (!options.apiKey) throw new TypeError("datadogSink: apiKey is required");
  const url =
    options.url ?? `https://http-intake.logs.${options.site ?? "datadoghq.com"}/api/v2/logs`;
  const maxEntries = Math.min(options.maxEntries ?? DATADOG_MAX_ENTRIES, DATADOG_MAX_ENTRIES);
  const maxBytes = Math.min(options.maxBytes ?? DATADOG_MAX_BYTES, DATADOG_MAX_BYTES);

  return {
    kind: "datadog",
    async send(batch) {
      if (batch.items.length === 0) return;
      const logs = batch.items.map((item) => JSON.stringify(toDatadogLog(item, batch, options)));
      const extra = await resolveHeaders(options.headers, batch);
      // `[` + `]` around comma-separated entries.
      for (const chunk of chunkSerialized(logs, { maxEntries, maxBytes, overheadBytes: 2 })) {
        await sendRequest(
          "datadog",
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...extra,
              "dd-api-key": options.apiKey,
            },
            body: `[${chunk.join(",")}]`,
          },
          options,
        );
      }
    },
  };
}
