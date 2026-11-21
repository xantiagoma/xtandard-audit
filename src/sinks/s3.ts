/**
 * S3-compatible object-store sink (AWS S3, Cloudflare R2, MinIO, Backblaze B2,
 * …): archives each batch as one JSONL object at an **idempotent** key, plus
 * one JSON object per signed checkpoint (witness copies, ADR 0004).
 *
 * ```txt
 * {prefix}{tenant}/{yyyy}/{mm}/{dd}/{firstSeq}-{lastSeq}.jsonl   one event per line
 * {prefix}{tenant}/checkpoints/{checkpoint id}.json               one per checkpoint
 * ```
 *
 * Seqs are zero-padded to 12 digits so a listing sorts in chain order; the
 * date is the first event's `recordedAt` (UTC), which grows with `seq`. A
 * re-sent batch overwrites the same key with the same content.
 *
 * Requests are signed with SigV4 by the optional peer
 * [`aws4fetch`](https://github.com/mhart/aws4fetch) (`bun add aws4fetch`), or
 * by any client you pass with a compatible `fetch` method.
 *
 * @module
 */

import type { AuditSink, StreamBatch } from "../streams.ts";
import { requirePeer } from "../storage/contract.ts";
import { sendRequest } from "./shared.ts";

export { SinkHttpError } from "./shared.ts";

/** A SigV4-signing client: `aws4fetch`'s `AwsClient` or anything with the same `fetch`. */
export interface S3Client {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Options for {@link s3Sink}. */
export interface S3SinkOptions {
  /** Bucket name. */
  bucket: string;
  /** Key prefix, e.g. `"audit/"`. Default `""`. */
  prefix?: string;
  /** A prebuilt signing client (e.g. `new AwsClient({ … })`). Otherwise pass credentials. */
  client?: S3Client;
  /** Access key id (with `secretAccessKey`; ignored when `client` is given). */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /**
   * Region. Default `"us-east-1"` for AWS, `"auto"` when `endpoint` is set
   * (R2 expects `"auto"`).
   */
  region?: string;
  /**
   * Endpoint for S3-compatible stores, e.g. `https://<account>.r2.cloudflarestorage.com`
   * or `http://localhost:9000` (MinIO). Default: AWS (`https://s3.<region>.amazonaws.com`).
   */
  endpoint?: string;
  /**
   * Path-style URLs (`{endpoint}/{bucket}/{key}`) instead of virtual-hosted
   * (`{bucket}.{host}/{key}`). Default `true` with `endpoint`, `false` for AWS.
   */
  pathStyle?: boolean;
  /** Upload checkpoints too (default `true`). */
  checkpoints?: boolean;
  /** Request timeout. Default 30 000 ms. */
  timeoutMs?: number;
}

const pad = (n: number) => String(n).padStart(12, "0");
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * The object keys a batch is written to (exported for tooling and tests).
 *
 * @example
 * ```ts
 * s3ObjectKeys(batch, "audit/");
 * // { events: "audit/acme/2026/11/20/000000000001-000000000100.jsonl",
 * //   checkpoints: ["audit/acme/checkpoints/chk_01J….json"] }
 * ```
 */
export function s3ObjectKeys(
  batch: StreamBatch,
  prefix = "",
): { events: string | null; checkpoints: string[] } {
  const events = batch.items.flatMap((i) => (i.kind === "event" ? [i.event] : []));
  let eventsKey: string | null = null;
  if (events.length > 0) {
    const first = events[0]!;
    const last = events[events.length - 1]!;
    const d = new Date(first.recordedAt);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    eventsKey = `${prefix}${batch.tenant}/${yyyy}/${mm}/${dd}/${pad(first.seq)}-${pad(last.seq)}.jsonl`;
  }
  const checkpoints = batch.items.flatMap((i) =>
    i.kind === "checkpoint" ? [`${prefix}${batch.tenant}/checkpoints/${i.checkpoint.id}.json`] : [],
  );
  return { events: eventsKey, checkpoints };
}

/**
 * Create an S3-compatible archive sink.
 *
 * @example
 * ```ts
 * import { s3Sink } from "@xtandard/audit/sinks/s3";
 *
 * // Cloudflare R2
 * const sink = s3Sink({
 *   bucket: "audit-archive",
 *   prefix: "prod/",
 *   endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
 *   accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 * });
 *
 * // or a prebuilt client
 * import { AwsClient } from "aws4fetch";
 * const sink2 = s3Sink({ bucket: "audit", region: "eu-west-1", client: new AwsClient({ … }) });
 * ```
 */
export function s3Sink(options: S3SinkOptions): AuditSink {
  if (!options.bucket) throw new TypeError("s3Sink: bucket is required");
  if (!options.client && !(options.accessKeyId && options.secretAccessKey)) {
    throw new TypeError("s3Sink: pass a client, or accessKeyId + secretAccessKey");
  }
  const region = options.region ?? (options.endpoint ? "auto" : "us-east-1");
  const pathStyle = options.pathStyle ?? options.endpoint !== undefined;
  const base = new URL(options.endpoint ?? `https://s3.${region}.amazonaws.com`);
  const origin = pathStyle
    ? `${base.origin}${base.pathname.replace(/\/+$/, "")}/${encodeURIComponent(options.bucket)}`
    : `${base.protocol}//${options.bucket}.${base.host}${base.pathname.replace(/\/+$/, "")}`;
  const prefix = options.prefix ?? "";

  let client: Promise<S3Client> | null = options.client ? Promise.resolve(options.client) : null;
  function getClient(): Promise<S3Client> {
    client ??= import("aws4fetch").then(
      ({ AwsClient }) =>
        new AwsClient({
          accessKeyId: options.accessKeyId!,
          secretAccessKey: options.secretAccessKey!,
          ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
          service: "s3",
          region,
        }),
      () => requirePeer("aws4fetch", "sinks/s3"),
    );
    return client;
  }

  async function put(key: string, body: string, contentType: string): Promise<void> {
    const c = await getClient();
    // Sign the real payload hash (not UNSIGNED-PAYLOAD): S3 rejects a body altered in flight.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    await sendRequest(
      "s3",
      `${origin}/${encodeKey(key)}`,
      {
        method: "PUT",
        headers: { "content-type": contentType, "x-amz-content-sha256": sha256 },
        body,
      },
      {
        fetch: (input, init) => c.fetch(String(input), init),
        timeoutMs: options.timeoutMs ?? 30_000,
      },
    );
  }

  return {
    kind: "s3",
    async send(batch) {
      if (batch.items.length === 0) return;
      const keys = s3ObjectKeys(batch, prefix);
      if (keys.events) {
        const lines = batch.items.flatMap((i) =>
          i.kind === "event" ? [JSON.stringify(i.event)] : [],
        );
        await put(keys.events, lines.join("\n") + "\n", "application/x-ndjson");
      }
      if (options.checkpoints ?? true) {
        let n = 0;
        for (const item of batch.items) {
          if (item.kind !== "checkpoint") continue;
          await put(keys.checkpoints[n++]!, JSON.stringify(item.checkpoint), "application/json");
        }
      }
    },
  };
}
