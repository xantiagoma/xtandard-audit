/**
 * Shared plumbing for the official sinks (ADR 0008): a timed `fetch`, the
 * error a sink throws on a rejected batch, and small item helpers.
 *
 * Internal — each sink is its own subpath (`@xtandard/audit/sinks/<name>`).
 *
 * @module
 */

import type { StreamBatch, StreamItem } from "../streams.ts";

/** The `fetch` shape sinks call (inject one for tests, proxies, or custom agents). */
export type SinkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Default request timeout for HTTP sinks. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Max characters of a rejecting response body kept in the error message. */
const ERROR_BODY_LIMIT = 500;

/**
 * Thrown by an HTTP-based sink when the destination answered non-2xx (or a
 * 2xx with an error payload, e.g. Splunk's `code != 0`). The stream runner
 * records `message` as the cursor's `lastError` and backs off.
 */
export class SinkHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(kind: string, status: number, body: string) {
    const snippet = body.length > ERROR_BODY_LIMIT ? `${body.slice(0, ERROR_BODY_LIMIT)}…` : body;
    super(`${kind} sink: HTTP ${status}${snippet ? ` — ${snippet}` : ""}`);
    this.name = "SinkHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * POST/PUT with a timeout. Resolves with the response when it is 2xx; throws
 * {@link SinkHttpError} otherwise, and a timeout error when the destination
 * does not answer within `timeoutMs`.
 */
export async function sendRequest(
  kind: string,
  url: string,
  init: RequestInit,
  options: { fetch?: SinkFetch; timeoutMs?: number },
): Promise<Response> {
  const doFetch = options.fetch ?? ((input, i) => globalThis.fetch(input, i));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${kind} sink: timed out after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SinkHttpError(kind, response.status, body);
  }
  return response;
}

/** Static headers, or a (possibly async) function resolved per request (rotating tokens). */
export type SinkHeaders =
  | Record<string, string>
  | ((batch: StreamBatch) => Record<string, string> | Promise<Record<string, string>>);

/** Resolve {@link SinkHeaders} for one batch. */
export async function resolveHeaders(
  headers: SinkHeaders | undefined,
  batch: StreamBatch,
): Promise<Record<string, string>> {
  if (!headers) return {};
  return typeof headers === "function" ? headers(batch) : headers;
}

/** The id of an item: the event id or the checkpoint id. */
export function itemId(item: StreamItem): string {
  return item.kind === "event" ? item.event.id : item.checkpoint.id;
}

/** The tenant of an item. */
export function itemTenant(item: StreamItem): string {
  return item.kind === "event" ? item.event.tenant : item.checkpoint.tenant;
}

/** When the item happened: `occurredAt` for events, `at` for checkpoints (ISO-8601). */
export function itemTime(item: StreamItem): string {
  return item.kind === "event" ? item.event.occurredAt : item.checkpoint.at;
}

/**
 * The default event-type name of an item: `audit.<action>` for events,
 * `audit.checkpoint` for checkpoints.
 */
export function defaultItemType(item: StreamItem): string {
  return item.kind === "event" ? `audit.${item.event.action}` : "audit.checkpoint";
}

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Split serialized entries into chunks that respect both a count and a byte
 * budget (each chunk's `bytes` is the sum of its entries' lengths plus
 * `separatorBytes` between them). A single entry larger than `maxBytes` gets
 * a chunk of its own — the destination decides (truncate or reject).
 */
export function chunkSerialized(
  entries: string[],
  limits: { maxEntries: number; maxBytes: number; separatorBytes?: number; overheadBytes?: number },
): string[][] {
  const sep = limits.separatorBytes ?? 1;
  const overhead = limits.overheadBytes ?? 0;
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = overhead;
  for (const entry of entries) {
    const size = byteLength(entry);
    const added = current.length === 0 ? size : size + sep;
    if (
      current.length > 0 &&
      (current.length >= limits.maxEntries || bytes + added > limits.maxBytes)
    ) {
      chunks.push(current);
      current = [];
      bytes = overhead;
    }
    bytes += current.length === 0 ? size : size + sep;
    current.push(entry);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
