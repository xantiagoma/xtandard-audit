/**
 * Generic HTTP sink: `httpSink()` POSTs each stream batch as JSON or NDJSON;
 * non-2xx throws so the stream runner backs off. Zero dependencies.
 *
 * Import from `@xtandard/audit/sinks/http`.
 *
 * @module sinks/http
 */

export * from "./sinks/http.ts";
