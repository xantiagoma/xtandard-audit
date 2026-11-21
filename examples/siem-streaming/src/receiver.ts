/**
 * The other side of the streams: a local server playing a SIEM's HTTP intake
 * (`POST /ingest`) and a customer's webhook endpoint (`POST /webhook`, verified
 * with `@xtandard/webhooks/receiver`). Each route rejects its first `failFirst`
 * requests with a 503 so you can watch the runner back off and retry.
 */
import { verifyWebhook } from "@xtandard/webhooks/receiver";
import type { StreamBatch, StreamItem } from "@xtandard/audit";

export interface Receiver {
  url: string;
  /** Item ids accepted per route (dedupe on them: delivery is at-least-once). */
  accepted: { ingest: Set<string>; webhook: Set<string> };
  stop(): void;
}

const itemId = (item: StreamItem) => (item.kind === "event" ? item.event.id : item.checkpoint.id);

function describe(items: StreamItem[]): string {
  const seqs = items.flatMap((i) => (i.kind === "event" ? [i.event.seq] : []));
  const cps = items.filter((i) => i.kind === "checkpoint").length;
  const [lo, hi] = [Math.min(...seqs), Math.max(...seqs)];
  const range = seqs.length === 0 ? "no events" : lo === hi ? `#${lo}` : `#${lo}–#${hi}`;
  return `${range}${cps ? ` + ${cps} signed checkpoint${cps > 1 ? "s" : ""}` : ""}`;
}

export function startReceiver(options: { failFirst: number; webhookSecret: string }): Receiver {
  const seen = { ingest: 0, webhook: 0 };
  const accepted = { ingest: new Set<string>(), webhook: new Set<string>() };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const route = new URL(request.url).pathname.slice(1);
      if (route !== "ingest" && route !== "webhook")
        return new Response("not found", { status: 404 });
      const n = ++seen[route];
      if (n <= options.failFirst) {
        await request.arrayBuffer();
        console.log(
          `  ← ${route.padEnd(7)} 503 (failing request ${n}/${options.failFirst} on purpose)`,
        );
        return new Response("temporarily unavailable", { status: 503 });
      }
      let batch: StreamBatch;
      if (route === "webhook") {
        // Standard Webhooks: verify the signature before trusting a byte of it.
        try {
          const envelope = await verifyWebhook(request, options.webhookSecret);
          batch = envelope.data as unknown as StreamBatch;
        } catch (err) {
          console.log(`  ← webhook 401 (${err instanceof Error ? err.message : String(err)})`);
          return new Response("invalid signature", { status: 401 });
        }
      } else {
        batch = (await request.json()) as StreamBatch;
      }
      for (const item of batch.items) accepted[route].add(itemId(item));
      const verified = route === "webhook" ? " (signature verified)" : "";
      console.log(
        `  ← ${route.padEnd(7)} 200 ${batch.tenant}: ${describe(batch.items)}${verified}`,
      );
      return new Response(null, { status: 200 });
    },
  });

  return { url: server.url.origin, accepted, stop: () => server.stop(true) };
}
