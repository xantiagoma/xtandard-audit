import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { afterEach, describe, expect, it } from "vitest";
import { s3ObjectKeys, s3Sink, type S3Client } from "../src/sinks/s3.ts";
import type { StreamItem } from "../src/streams.ts";
import { makeBatch, startServer } from "./sinks-fixtures.ts";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

/** A client that records URLs instead of signing. */
function recordingClient(status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client: S3Client = {
    async fetch(url, init) {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response(status === 200 ? "" : "<Error><Code>AccessDenied</Code></Error>", {
        status,
      });
    },
  };
  return { client, calls };
}

describe("s3ObjectKeys", () => {
  it("dates by the first event's recordedAt, pads seqs, one key per checkpoint", async () => {
    const batch = await makeBatch({ count: 3, checkpoint: true });
    const first = batch.items[0] as Extract<StreamItem, { kind: "event" }>;
    const d = new Date(first.event.recordedAt);
    const ymd = [
      d.getUTCFullYear(),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    ].join("/");
    const cp = batch.items[3] as Extract<StreamItem, { kind: "checkpoint" }>;
    expect(s3ObjectKeys(batch, "audit/")).toEqual({
      events: `audit/acme/${ymd}/000000000001-000000000003.jsonl`,
      checkpoints: [`audit/acme/checkpoints/${cp.checkpoint.id}.json`],
    });
    expect(s3ObjectKeys({ ...batch, items: [cp] })).toEqual({
      events: null,
      checkpoints: [`acme/checkpoints/${cp.checkpoint.id}.json`],
    });
  });
});

describe("s3Sink", () => {
  it("signs PUTs with aws4fetch against a fake S3 (path-style endpoint)", async () => {
    const server = await startServer();
    close = server.close;
    const batch = await makeBatch({ count: 2, checkpoint: true, tenant: "org:acme" });
    await s3Sink({
      bucket: "archive",
      prefix: "prod/",
      endpoint: server.url,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session",
    }).send(batch);

    expect(server.requests.map((r) => r.method)).toEqual(["PUT", "PUT"]);
    const keys = s3ObjectKeys(batch, "prod/");
    const [events, checkpoint] = server.requests;
    expect(events!.url).toBe(`/archive/${keys.events!.replace("org:acme", "org%3Aacme")}`);
    expect(events!.headers["content-type"]).toBe("application/x-ndjson");
    expect(events!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
    );
    expect(events!.headers["x-amz-security-token"]).toBe("session");
    expect(events!.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update(events!.body).digest("hex"),
    );
    const lines = events!.body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq: number });
    expect(lines.map((e) => e.seq)).toEqual([1, 2]);

    expect(checkpoint!.url).toBe(
      `/archive/${keys.checkpoints[0]!.replace("org:acme", "org%3Aacme")}`,
    );
    expect(checkpoint!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(checkpoint!.body)).toMatchObject({
      kind: "head",
      seq: 2,
      tenant: "org:acme",
    });
  });

  it("defaults to AWS virtual-hosted URLs in us-east-1", async () => {
    const { client, calls } = recordingClient();
    await s3Sink({ bucket: "b", client }).send(await makeBatch({ count: 1 }));
    expect(calls[0]!.url).toMatch(
      /^https:\/\/b\.s3\.us-east-1\.amazonaws\.com\/acme\/\d{4}\/\d{2}\/\d{2}\//,
    );
    expect(calls[0]!.init?.method).toBe("PUT");
  });

  it("honours region, pathStyle and endpoint sub-paths; checkpoints can be skipped", async () => {
    const { client, calls } = recordingClient();
    await s3Sink({
      bucket: "b",
      client,
      region: "eu-west-1",
      pathStyle: true,
      checkpoints: false,
    }).send(await makeBatch({ count: 1, checkpoint: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/^https:\/\/s3\.eu-west-1\.amazonaws\.com\/b\/acme\//);

    const r2 = recordingClient();
    await s3Sink({
      bucket: "b",
      client: r2.client,
      endpoint: "https://minio.test/s3/",
      pathStyle: false,
    }).send(await makeBatch({ count: 1 }));
    expect(r2.calls[0]!.url).toMatch(/^https:\/\/b\.minio\.test\/s3\/acme\//);
  });

  it("works with a prebuilt AwsClient", async () => {
    const server = await startServer();
    close = server.close;
    const client = new AwsClient({
      accessKeyId: "A",
      secretAccessKey: "S",
      service: "s3",
      region: "auto",
    });
    await s3Sink({ bucket: "b", endpoint: server.url, client }).send(await makeBatch({ count: 1 }));
    expect(server.requests[0]!.headers.authorization).toContain("Credential=A/");
  });

  it("throws on non-2xx, validates options, skips empty batches", async () => {
    const { client } = recordingClient(403);
    await expect(
      s3Sink({ bucket: "b", client }).send(await makeBatch({ count: 1 })),
    ).rejects.toThrow("s3 sink: HTTP 403 — <Error><Code>AccessDenied</Code></Error>");
    expect(() => s3Sink({ bucket: "", client })).toThrow("bucket is required");
    expect(() => s3Sink({ bucket: "b" })).toThrow(
      "pass a client, or accessKeyId + secretAccessKey",
    );
    const ok = recordingClient();
    await s3Sink({ bucket: "b", client: ok.client }).send({ stream: "s", tenant: "t", items: [] });
    expect(ok.calls).toHaveLength(0);
  });
});
