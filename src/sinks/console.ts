/**
 * Console sink: prints each streamed item — a readable one-liner (`"pretty"`)
 * or one JSON object per line (`"json"`, for log shippers that tail stdout).
 * For development, demos, and containers whose stdout is already collected.
 * Zero dependencies.
 *
 * @module
 */

import type { AuditSink, StreamBatch, StreamItem } from "../streams.ts";

/** Options for {@link consoleSink}. */
export interface ConsoleSinkOptions {
  /** `"pretty"` (default) or `"json"` (one `{ stream, tenant, kind, event|checkpoint }` per line). */
  format?: "pretty" | "json";
  /** Where lines go. Default `console.log`. */
  write?: (line: string) => void;
}

/** The one-line pretty form of an item. */
export function prettyLine(item: StreamItem, batch: StreamBatch): string {
  if (item.kind === "checkpoint") {
    const cp = item.checkpoint;
    return `[${batch.stream}] ${cp.tenant} checkpoint #${cp.seq} ${cp.hash} (${cp.alg} ${cp.keyId}) ${cp.id}`;
  }
  const e = item.event;
  const actor = e.actor.name ? `${e.actor.name} <${e.actor.id}>` : e.actor.id;
  const targets = e.targets.map((t) => `${t.type}:${t.id}`).join(" ");
  const outcome = e.outcome === "failure" ? " ✗" : "";
  return `[${batch.stream}] ${e.tenant} #${e.seq} ${e.occurredAt} ${e.action}${outcome} by ${actor}${
    targets ? ` → ${targets}` : ""
  } ${e.id}`;
}

/**
 * Create a console sink.
 *
 * @example
 * ```ts
 * import { consoleSink } from "@xtandard/audit/sinks/console";
 *
 * createStreamRunner(audit, { streams: [{ name: "stdout", sink: consoleSink({ format: "json" }) }] });
 * ```
 */
export function consoleSink(options: ConsoleSinkOptions = {}): AuditSink {
  const format = options.format ?? "pretty";
  // eslint-disable-next-line no-console
  const write = options.write ?? ((line: string) => console.log(line));
  return {
    kind: "console",
    async send(batch) {
      for (const item of batch.items) {
        write(
          format === "json"
            ? JSON.stringify({ stream: batch.stream, tenant: batch.tenant, ...item })
            : prettyLine(item, batch),
        );
      }
    },
  };
}
