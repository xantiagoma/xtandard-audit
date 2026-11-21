/**
 * File sink + recorder fallback, both appending JSON Lines with `node:fs`
 * (Bun and Node):
 *
 * - `fileSink({ path })` — a stream sink: appends one `StreamItem` per line
 *   (`{ "kind": "event", "event": … }` / `{ "kind": "checkpoint", … }`);
 *   `path` may depend on the batch (per-tenant files).
 * - `fileFallback(path)` — a `RecorderFallback` for the buffered recorder
 *   (ADR 0002): when storage keeps failing, the batch is appended as
 *   `{ "at", "error", "input" }` lines so nothing is lost; replay them later
 *   with `core.recordMany(lines.map((l) => l.input))`.
 *
 * Both `fsync` by default — the write is durable before the promise resolves.
 *
 * @module
 */

import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { RecordInput } from "../core.ts";
import type { RecorderFallback } from "../recorder.ts";
import type { AuditSink, StreamBatch } from "../streams.ts";

/** Options for {@link fileSink}. */
export interface FileSinkOptions {
  /** File to append to, or a function of the batch (e.g. one file per tenant). */
  path: string | ((batch: StreamBatch) => string);
  /** `fsync` after each append. Default `true`. */
  fsync?: boolean;
}

/** Options for {@link fileFallback}. */
export interface FileFallbackOptions {
  /** `fsync` after each append. Default `true`. */
  fsync?: boolean;
}

/** Append text to a file (creating parent directories), optionally fsync'd. */
async function appendDurable(path: string, text: string, fsync: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.appendFile(text, "utf8");
    if (fsync) await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Create a JSONL file sink.
 *
 * @example
 * ```ts
 * import { fileSink } from "@xtandard/audit/sinks/file";
 *
 * const sink = fileSink({ path: (batch) => `./audit-archive/${batch.tenant}.jsonl` });
 * ```
 */
export function fileSink(options: FileSinkOptions): AuditSink {
  const fsync = options.fsync ?? true;
  return {
    kind: "file",
    async send(batch) {
      if (batch.items.length === 0) return;
      const path = typeof options.path === "function" ? options.path(batch) : options.path;
      const text = batch.items.map((item) => JSON.stringify(item) + "\n").join("");
      await appendDurable(path, text, fsync);
    },
  };
}

/** One line written by {@link fileFallback}. */
export interface FallbackLine {
  /** ISO-8601 time the batch was parked. */
  at: string;
  /** The storage error message. */
  error: string;
  /** The original record input (ambient context already resolved). */
  input: RecordInput;
}

/**
 * A {@link RecorderFallback} that appends batches the recorder could not
 * persist to a JSONL file.
 *
 * @example
 * ```ts
 * import { createRecorder } from "@xtandard/audit";
 * import { fileFallback } from "@xtandard/audit/sinks/file";
 *
 * const recorder = createRecorder(audit, {
 *   fallback: fileFallback("/var/lib/app/audit-fallback.jsonl"),
 *   onError: (err, batch) => logger.error({ err, parked: batch.length }, "audit storage down"),
 * });
 * ```
 */
export function fileFallback(path: string, options: FileFallbackOptions = {}): RecorderFallback {
  const fsync = options.fsync ?? true;
  return {
    async write(inputs, error) {
      const at = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const text = inputs
        .map((input) => JSON.stringify({ at, error: message, input } satisfies FallbackLine) + "\n")
        .join("");
      await appendDurable(path, text, fsync);
    },
  };
}

/**
 * Parse a fallback file's content back into record inputs (for replay with
 * `core.recordMany`). Blank lines are skipped.
 *
 * @example
 * ```ts
 * import { readFile } from "node:fs/promises";
 * import { readFallbackLines } from "@xtandard/audit/sinks/file";
 *
 * const lines = readFallbackLines(await readFile(path, "utf8"));
 * await audit.recordMany(lines.map((l) => l.input));
 * ```
 */
export function readFallbackLines(text: string): FallbackLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FallbackLine);
}
