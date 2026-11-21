import { describe, expect, it } from "vitest";
import {
  DATADOG_MAX_ENTRIES,
  datadogSink,
  defaultLogMessage,
  toDatadogLog,
} from "../src/sinks/datadog.ts";
import { chunkSerialized } from "../src/sinks/shared.ts";
import { splunkSink, toSplunkEvent } from "../src/sinks/splunk.ts";
import type { StreamBatch, StreamItem } from "../src/streams.ts";
import { makeBatch, stubFetch } from "./sinks-fixtures.ts";

/** Repeat a batch's first event `n` times (cheap large batches). */
async function bigBatch(n: number, metadataBytes = 0): Promise<StreamBatch> {
  const base = await makeBatch({ count: 1 });
  const item = base.items[0] as Extract<StreamItem, { kind: "event" }>;
  const event = { ...item.event, metadata: { blob: "x".repeat(metadataBytes) } };
  return { ...base, items: Array.from({ length: n }, () => ({ kind: "event", event })) };
}

describe("datadogSink", () => {
  it("POSTs an array of logs to the site's v2 intake with DD-API-KEY", async () => {
    const { fetch, calls } = stubFetch(() => new Response("{}", { status: 202 }));
    const batch = await makeBatch({ count: 2, checkpoint: true });
    await datadogSink({
      apiKey: "k",
      site: "datadoghq.eu",
      hostname: "web-1",
      tags: ["env:prod"],
      fetch,
    }).send(batch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://http-intake.logs.datadoghq.eu/api/v2/logs");
    expect(calls[0]!.headers["dd-api-key"]).toBe("k");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    const logs = JSON.parse(calls[0]!.body) as Record<string, any>[];
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({
      ddsource: "xtandard-audit",
      service: "xtandard-audit",
      hostname: "web-1",
      ddtags: "tenant:acme,stream:siem,kind:event,action:invoice.paid,env:prod",
      message: "User 0 invoice.paid invoice:inv_0",
      status: "info",
      audit: { action: "invoice.paid", tenant: "acme" },
    });
    expect(logs[1]).toMatchObject({
      status: "warn",
      ddtags: expect.stringContaining("outcome:failure"),
      message: expect.stringContaining("(failed)"),
    });
    expect(logs[2]).toMatchObject({ ddtags: "tenant:acme,stream:siem,kind:checkpoint,env:prod" });
    expect(logs[2]!.message).toMatch(/^audit checkpoint acme #2 sha256:/);
    expect(logs[2]!.audit.signature).toBeTruthy();
  });

  it("defaults to datadoghq.com, honours url / service / source / message overrides", async () => {
    const { fetch, calls } = stubFetch();
    await datadogSink({ apiKey: "k", fetch }).send(await makeBatch({ count: 1 }));
    expect(calls[0]!.url).toBe("https://http-intake.logs.datadoghq.com/api/v2/logs");
    const batch = await makeBatch({ count: 1 });
    const log = toDatadogLog(batch.items[0]!, batch, {
      service: "billing",
      source: "audit",
      message: () => "custom",
    });
    expect(log).toMatchObject({ service: "billing", ddsource: "audit", message: "custom" });
    expect(log).not.toHaveProperty("hostname");
    const { fetch: f2, calls: c2 } = stubFetch();
    await datadogSink({ apiKey: "k", url: "http://proxy.test/logs", fetch: f2 }).send(batch);
    expect(c2[0]!.url).toBe("http://proxy.test/logs");
  });

  it("messages use the description when present, and sanitize tag values", async () => {
    const batch = await makeBatch({ count: 1, tenant: "org:acme" });
    const item = batch.items[0] as Extract<StreamItem, { kind: "event" }>;
    expect(
      defaultLogMessage({ kind: "event", event: { ...item.event, description: "Ada paid" } }),
    ).toBe("Ada paid");
    const log = toDatadogLog(item, { ...batch, stream: "a b,c" });
    expect(log.ddtags).toContain("stream:a_b_c");
  });

  it("splits batches at 1000 logs per request", async () => {
    const { fetch, calls } = stubFetch();
    await datadogSink({ apiKey: "k", fetch }).send(await bigBatch(DATADOG_MAX_ENTRIES + 5));
    expect(calls.map((c) => (JSON.parse(c.body) as unknown[]).length)).toEqual([1000, 5]);
  });

  it("splits batches by bytes (maxBytes)", async () => {
    const { fetch, calls } = stubFetch();
    await datadogSink({ apiKey: "k", fetch, maxBytes: 5_000 }).send(await bigBatch(10, 1_500));
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls)
      expect(new TextEncoder().encode(c.body).length).toBeLessThanOrEqual(5_000);
    expect(calls.flatMap((c) => JSON.parse(c.body) as unknown[])).toHaveLength(10);
  });

  it("throws on a rejected chunk and requires an apiKey", async () => {
    const { fetch } = stubFetch(() => new Response("Forbidden", { status: 403 }));
    await expect(datadogSink({ apiKey: "k", fetch }).send(await makeBatch())).rejects.toThrow(
      "datadog sink: HTTP 403 — Forbidden",
    );
    expect(() => datadogSink({ apiKey: "" })).toThrow("apiKey is required");
  });
});

describe("chunkSerialized", () => {
  it("respects count and byte limits, oversize entries get their own chunk", () => {
    expect(chunkSerialized(["aa", "bb", "cc"], { maxEntries: 2, maxBytes: 100 })).toEqual([
      ["aa", "bb"],
      ["cc"],
    ]);
    // "aa,bb" = 5 bytes + 2 overhead = 7 ≤ 7; adding ",cc" would exceed.
    expect(
      chunkSerialized(["aa", "bb", "cc"], { maxEntries: 10, maxBytes: 7, overheadBytes: 2 }),
    ).toEqual([["aa", "bb"], ["cc"]]);
    expect(chunkSerialized(["x".repeat(50), "y"], { maxEntries: 10, maxBytes: 10 })).toEqual([
      ["x".repeat(50)],
      ["y"],
    ]);
    expect(chunkSerialized([], { maxEntries: 1, maxBytes: 1 })).toEqual([]);
  });
});

describe("splunkSink", () => {
  it("POSTs concatenated HEC events with Authorization: Splunk <token>", async () => {
    const { fetch, calls } = stubFetch(
      () => new Response('{"text":"Success","code":0}', { status: 200 }),
    );
    const batch = await makeBatch({ count: 2, checkpoint: true });
    await splunkSink({
      url: "https://splunk.test:8088/",
      token: "tok",
      index: "audit",
      host: "web-1",
      channel: "chan-1",
      fetch,
    }).send(batch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://splunk.test:8088/services/collector/event");
    expect(calls[0]!.headers.authorization).toBe("Splunk tok");
    expect(calls[0]!.headers["x-splunk-request-channel"]).toBe("chan-1");
    const events = calls[0]!.body.split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(events).toHaveLength(3);
    const first = batch.items[0] as Extract<StreamItem, { kind: "event" }>;
    expect(events[0]).toEqual({
      time: Date.parse(first.event.occurredAt) / 1000,
      host: "web-1",
      source: "xtandard-audit",
      sourcetype: "xtandard:audit",
      index: "audit",
      fields: { tenant: "acme", stream: "siem", kind: "event", action: "invoice.paid" },
      event: JSON.parse(JSON.stringify(first.event)),
    });
    expect(events[2]!.fields).toEqual({ tenant: "acme", stream: "siem", kind: "checkpoint" });
    expect(events[2]!.event.signature).toBeTruthy();
  });

  it("keeps an explicit collector path; fields can be disabled; minimal event shape", async () => {
    const { fetch, calls } = stubFetch();
    const batch = await makeBatch({ count: 1 });
    await splunkSink({ url: "https://s.test/services/collector", token: "t", fetch }).send(batch);
    expect(calls[0]!.url).toBe("https://s.test/services/collector");
    const ev = toSplunkEvent(batch.items[0]!, batch, { fields: false, sourcetype: "custom" });
    expect(Object.keys(ev).sort()).toEqual(["event", "source", "sourcetype", "time"]);
    expect(ev.sourcetype).toBe("custom");
  });

  it("a 2xx with a non-zero HEC code fails; non-2xx fails; token required", async () => {
    const { fetch } = stubFetch(() => new Response('{"text":"Invalid data format","code":6}'));
    await expect(
      splunkSink({ url: "https://s.test", token: "t", fetch }).send(await makeBatch()),
    ).rejects.toThrow('splunk sink: HTTP 200 — {"text":"Invalid data format","code":6}');
    const { fetch: f2 } = stubFetch(() => new Response("Unauthorized", { status: 401 }));
    await expect(
      splunkSink({ url: "https://s.test", token: "t", fetch: f2 }).send(await makeBatch()),
    ).rejects.toThrow("HTTP 401");
    expect(() => splunkSink({ url: "https://s.test", token: "" })).toThrow("token is required");
  });

  it("splits large batches by maxBytes", async () => {
    const { fetch, calls } = stubFetch();
    await splunkSink({ url: "https://s.test", token: "t", fetch, maxBytes: 4_000 }).send(
      await bigBatch(6, 1_500),
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap((c) => c.body.split("\n"))).toHaveLength(6);
  });
});
