/**
 * File sink and recorder fallback: `fileSink()` appends streamed items as JSON
 * Lines; `fileFallback()` parks batches the buffered recorder could not
 * persist. Uses `node:fs` (Bun and Node).
 *
 * Import from `@xtandard/audit/sinks/file`.
 *
 * @module sinks/file
 */

export * from "./sinks/file.ts";
