import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyWebhook } from "@xtandard/webhooks/receiver";
import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, it } from "vitest";
import { batchWebhookId, signWebhook, webhookSink } from "../src/sinks/webhook.ts";
import { makeBatch, startServer, stubFetch } from "./sinks-fixtures.ts";

const newSecret = (bytes = 32) => `whsec_${randomBytes(bytes).toString("base64")}`;

/**
 * An independent implementation of the Standard Webhooks v1 check, straight
 * from the spec (node:crypto, no shared code with the sink).
 */
function specVerify(secret: string, headers: Record<string, string>, body: string): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`)
    .digest();
  return headers["webhook-signature"]!.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe("webhookSink", () => {
  it("signs batches verifiable by @xtandard/webhooks, standardwebhooks and the spec", async () => {
    const secret = newSecret();
    const server = await startServer();
    close = server.close;
    const batch = await makeBatch({ count: 3, checkpoint: true });
    await webhookSink({ url: `${server.url}/hooks`, secret }).send(batch);

    const req = server.requests[0]!;
    const headers = req.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["webhook-id"]).toMatch(/^bat_[0-9a-f]{32}$/);
    expect(headers["webhook-timestamp"]).toMatch(/^\d+$/);

    // 1. @xtandard/webhooks receiver
    const envelope = await verifyWebhook(
      new Request("http://x/hooks", { method: "POST", headers, body: req.body }),
      secret,
    );
    expect(envelope.type).toBe("audit.batch");
    expect(envelope.data).toEqual(
      JSON.parse(
        JSON.stringify({ stream: batch.stream, tenant: batch.tenant, items: batch.items }),
      ),
    );

    // 2. the official standardwebhooks library
    const verified = new Webhook(secret).verify(req.body, headers) as { type: string };
    expect(verified.type).toBe("audit.batch");

    // 3. an independent implementation of the spec
    expect(specVerify(secret, headers, req.body)).toBe(true);
    expect(specVerify(newSecret(), headers, req.body)).toBe(false);
  });

  it("rotation: one signature per secret, either verifies", async () => {
    const [a, b] = [newSecret(), newSecret(24)];
    const { fetch, calls } = stubFetch();
    await webhookSink({ url: "https://x.test/", secret: [a, b], fetch }).send(await makeBatch());
    const { headers, body } = calls[0]!;
    expect(headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    expect(new Webhook(a).verify(body, headers)).toBeTruthy();
    expect(new Webhook(b).verify(body, headers)).toBeTruthy();
  });

  it("item mode: one request per item, id = event/checkpoint id, typed envelope", async () => {
    const secret = newSecret();
    const { fetch, calls } = stubFetch();
    const batch = await makeBatch({ count: 2, checkpoint: true });
    await webhookSink({ url: "https://x.test/", secret, mode: "item", fetch }).send(batch);
    expect(calls).toHaveLength(3);
    const envelopes = calls.map((c) => new Webhook(secret).verify(c.body, c.headers)) as {
      type: string;
      timestamp: string;
      data: { id: string };
    }[];
    expect(envelopes.map((e) => e.type)).toEqual([
      "audit.invoice.paid",
      "audit.member.role_changed",
      "audit.checkpoint",
    ]);
    const ids = batch.items.map((i) => (i.kind === "event" ? i.event.id : i.checkpoint.id));
    expect(calls.map((c) => c.headers["webhook-id"])).toEqual(ids);
    expect(envelopes.map((e) => e.data.id)).toEqual(ids);
    const first = batch.items[0]!;
    expect(envelopes[0]!.timestamp).toBe(first.kind === "event" ? first.event.occurredAt : "");
  });

  it("a re-sent batch is byte-identical with the same webhook-id", async () => {
    const secret = newSecret();
    const { fetch, calls } = stubFetch();
    const sink = webhookSink({
      url: "https://x.test/",
      secret,
      fetch,
      now: () => 1_700_000_000_000,
    });
    const batch = await makeBatch({ count: 2 });
    await sink.send(batch);
    await sink.send(batch);
    expect(calls[0]!.headers).toEqual(calls[1]!.headers);
    expect(calls[0]!.body).toBe(calls[1]!.body);
    expect(calls[0]!.headers["webhook-timestamp"]).toBe("1700000000");
    // A single-item batch uses the item id.
    const single = { ...batch, items: batch.items.slice(0, 1) };
    const only = batch.items[0]!;
    expect(await batchWebhookId(single)).toBe(only.kind === "event" ? only.event.id : "");
  });

  it("custom types, headers; extra headers cannot override the signature headers", async () => {
    const secret = newSecret();
    const { fetch, calls } = stubFetch();
    await webhookSink({
      url: "https://x.test/",
      secret,
      fetch,
      batchType: "siem.batch",
      headers: { "x-extra": "1", "webhook-id": "spoof" },
    }).send(await makeBatch());
    expect(calls[0]!.headers["x-extra"]).toBe("1");
    expect(calls[0]!.headers["webhook-id"]).not.toBe("spoof");
    expect((JSON.parse(calls[0]!.body) as { type: string }).type).toBe("siem.batch");
  });

  it("signWebhook matches the spec's HMAC", async () => {
    const secret = newSecret();
    const sig = await signWebhook(secret, "msg_1", 1_700_000_000, '{"a":1}');
    expect(
      specVerify(
        secret,
        { "webhook-id": "msg_1", "webhook-timestamp": "1700000000", "webhook-signature": sig },
        '{"a":1}',
      ),
    ).toBe(true);
  });

  it("rejects bad secrets up front and non-2xx at send time", async () => {
    expect(() => webhookSink({ url: "https://x.test/", secret: "whsec_!!!" })).toThrow("base64");
    expect(() => webhookSink({ url: "https://x.test/", secret: "whsec_c2hvcnQ=" })).toThrow(
      "decodes to 5 bytes",
    );
    expect(() => webhookSink({ url: "https://x.test/", secret: [] })).toThrow("at least one");
    const { fetch } = stubFetch(() => new Response("nope", { status: 401 }));
    await expect(
      webhookSink({ url: "https://x.test/", secret: newSecret(), fetch }).send(await makeBatch()),
    ).rejects.toThrow("webhook sink: HTTP 401 — nope");
    const { fetch: f2, calls } = stubFetch();
    await webhookSink({ url: "https://x.test/", secret: newSecret(), fetch: f2 }).send({
      stream: "s",
      tenant: "t",
      items: [],
    });
    expect(calls).toHaveLength(0);
  });
});
