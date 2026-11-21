/**
 * S3-compatible archive sink: `s3Sink()` writes one JSONL object per batch at
 * an idempotent key (AWS S3, R2, MinIO, …). Requires the optional peer
 * `aws4fetch` unless you pass your own signing client.
 *
 * Import from `@xtandard/audit/sinks/s3`.
 *
 * @module sinks/s3
 */

export * from "./sinks/s3.ts";
