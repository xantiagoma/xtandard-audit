import { afterEach, describe, expect, it } from "vitest";
import { encodeHttpBatch, httpSink, SinkHttpError } from "../src/sinks/http.ts";
import { createStreamRunner } from "../src/streams.ts";
import { makeBatch, makeCore, startServer, stubFetch } from "./sinks-fixtures.ts";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe("httpSink", () => {
  it("POSTs { stream, tenant, items } as JSON to a real server", async () => {
    const server = await startServer();
    close = server.close;
    const batch = await makeBatch({ checkpoint: true });
    await httpSink({ url: `${server.url}/ingest`, headers: { authorization: "Bearer t" } }).send(
      batch,
    );
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/ingest");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.authorization).toBe("Bearer t");
    expect(JSON.parse(req.body)).toEqual(JSON.parse(JSON.stringify(batch)));
  });

  it("NDJSON: one item per line", async () => {
    const { fetch, calls } = stubFetch();
    const batch = await makeBatch({ count: 3, checkpoint: true });
    await httpSink({ url: "https://x.test/", format: "ndjson", fetch }).send(batch);
    expect(calls[0]!.headers["content-type"]).toBe("application/x-ndjson");
    const lines = calls[0]!.body.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["event", "event", "event", "checkpoint"]);
    expect(encodeHttpBatch(batch, "ndjson")).toBe(calls[0]!.body);
  });

  it("resolves function headers per batch and supports PUT", async () => {
    const { fetch, calls } = stubFetch();
    const batch = await makeBatch();
    await httpSink({
      url: "https://x.test/",
      method: "PUT",
      headers: async (b) => ({ "x-tenant": b.tenant }),
      fetch,
    }).send(batch);
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.headers["x-tenant"]).toBe("acme");
  });

  it("non-2xx throws SinkHttpError with the status and a body snippet", async () => {
    const { fetch } = stubFetch(() => new Response("x".repeat(2000), { status: 503 }));
    const err = await httpSink({ url: "https://x.test/", fetch })
      .send(await makeBatch())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinkHttpError);
    expect((err as SinkHttpError).status).toBe(503);
    expect((err as SinkHttpError).message).toMatch(/^http sink: HTTP 503 — x+…$/);
  });

  it("times out", async () => {
    const server = await startServer(() => ({ delayMs: 500 }));
    close = server.close;
    await expect(
      httpSink({ url: server.url, timeoutMs: 50 }).send(await makeBatch()),
    ).rejects.toThrow("http sink: timed out after 50 ms");
  });

  it("propagates network errors", async () => {
    const fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      httpSink({ url: "https://x.test/", fetch }).send(await makeBatch()),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("skips empty batches and rejects unknown formats", async () => {
    const { fetch, calls } = stubFetch();
    await httpSink({ url: "https://x.test/", fetch }).send({ stream: "s", tenant: "t", items: [] });
    expect(calls).toHaveLength(0);
    expect(() => httpSink({ url: "https://x.test/", format: "xml" as never })).toThrow(
      'unknown format "xml"',
    );
  });

  it("drives the stream runner: failure keeps the cursor, the retry delivers", async () => {
    let fail = true;
    const server = await startServer(() => (fail ? { status: 500, body: "down" } : {}));
    close = server.close;
    let t = Date.parse("2026-01-01T00:00:00Z");
    const core = makeCore(() => t);
    const errors: unknown[] = [];
    const runner = createStreamRunner(core, {
      streams: [{ name: "siem", sink: httpSink({ url: server.url }), startFrom: "beginning" }],
      onError: (e) => errors.push(e),
    });
    await core.record({ tenant: "acme", action: "user.login", actor: { id: "u1" } });
    await runner.tick();
    expect(errors).toHaveLength(1);
    let [status] = await runner.status();
    expect(status!.tenants[0]).toMatchObject({ cursor: 0, lag: 1, failures: 1 });
    expect(status!.tenants[0]!.lastError).toContain("HTTP 500 — down");

    fail = false;
    t += 60_000; // past the backoff
    await runner.tick();
    [status] = await runner.status();
    expect(status!.tenants[0]).toMatchObject({ cursor: 1, lag: 0, failures: 0 });
    const body = JSON.parse(server.requests.at(-1)!.body);
    expect(body.items[0].event.action).toBe("user.login");
    await runner.stop();
  });
});
