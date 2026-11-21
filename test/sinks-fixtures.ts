/**
 * Shared fixtures for the sink tests: a real core (memory storage + HMAC
 * signer) producing genuine chained events and signed checkpoints, a local
 * HTTP server that captures requests, and a `fetch` stub.
 *
 * No `.test.ts` suffix: imported by the sink suites, never run on its own.
 */

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuditCore } from "../src/core.ts";
import { hmacSigner } from "../src/integrity.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import type { StreamBatch, StreamItem } from "../src/streams.ts";

/** A core with a signer and auto-checkpoints off (tests call `checkpoint` explicitly). */
export function makeCore(now?: () => number) {
  return createAuditCore({
    storage: createMemoryStorage(),
    signer: hmacSigner("test-secret"),
    checkpoints: false,
    selfAudit: false,
    ...(now ? { now } : {}),
  });
}

/** Record `count` events (+ a checkpoint when asked) for `tenant` and return them as a batch. */
export async function makeBatch(
  options: { tenant?: string; count?: number; checkpoint?: boolean; stream?: string } = {},
): Promise<StreamBatch> {
  const tenant = options.tenant ?? "acme";
  const core = makeCore();
  const events = await core.recordMany(
    Array.from({ length: options.count ?? 2 }, (_, i) => ({
      tenant,
      action: i % 2 === 0 ? "invoice.paid" : "member.role_changed",
      actor: { id: `user_${i}`, name: `User ${i}` },
      targets: [{ type: "invoice", id: `inv_${i}` }],
      context: { ip: "10.0.0.1" },
      metadata: { amount: 100 * (i + 1) },
      ...(i === 1 ? { outcome: "failure" as const } : {}),
    })),
  );
  const items: StreamItem[] = events.map((event) => ({ kind: "event", event }));
  if (options.checkpoint) {
    items.push({ kind: "checkpoint", checkpoint: await core.checkpoint(tenant) });
  }
  return { stream: options.stream ?? "siem", tenant, items };
}

/** One request captured by {@link startServer}. */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * Start a local HTTP server. `respond` decides each answer (default 200 "ok").
 * Returns its base URL, the captured requests, and `close`.
 */
export async function startServer(
  respond: (
    req: CapturedRequest,
    index: number,
  ) => { status?: number; body?: string; delayMs?: number } = () => ({}),
): Promise<{ url: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const index = requests.push(captured) - 1;
      const answer = respond(captured, index);
      const finish = () => {
        res.writeHead(answer.status ?? 200, { "content-type": "text/plain" });
        res.end(answer.body ?? "ok");
      };
      if (answer.delayMs) setTimeout(finish, answer.delayMs);
      else finish();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A `fetch` stub that records calls and answers with `respond`. */
export function stubFetch(
  respond: (url: string, init: RequestInit, index: number) => Response | Promise<Response> = () =>
    new Response("ok", { status: 200 }),
) {
  const calls: { url: string; init: RequestInit; body: string; headers: Record<string, string> }[] =
    [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const index =
      calls.push({ url: String(input), init, body: String(init.body ?? ""), headers }) - 1;
    return respond(String(input), init, index);
  };
  return { fetch, calls };
}
