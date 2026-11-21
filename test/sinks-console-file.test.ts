import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { createRecorder } from "../src/recorder.ts";
import { consoleSink, prettyLine } from "../src/sinks/console.ts";
import { fileFallback, fileSink, readFallbackLines } from "../src/sinks/file.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import type { StreamItem } from "../src/streams.ts";
import { makeBatch } from "./sinks-fixtures.ts";

describe("consoleSink", () => {
  it("pretty: one readable line per item", async () => {
    const lines: string[] = [];
    const batch = await makeBatch({ count: 2, checkpoint: true });
    await consoleSink({ write: (l) => lines.push(l) }).send(batch);
    expect(lines).toHaveLength(3);
    const e0 = (batch.items[0] as Extract<StreamItem, { kind: "event" }>).event;
    expect(lines[0]).toBe(
      `[siem] acme #1 ${e0.occurredAt} invoice.paid by User 0 <user_0> → invoice:inv_0 ${e0.id}`,
    );
    expect(lines[1]).toContain("member.role_changed ✗ by User 1 <user_1>");
    expect(lines[2]).toMatch(/^\[siem\] acme checkpoint #2 sha256:[0-9a-f]+ \(HS256 hmac\) chk_/);
  });

  it("pretty: bare actor ids and no targets", async () => {
    const batch = await makeBatch({ count: 1 });
    const item = batch.items[0] as Extract<StreamItem, { kind: "event" }>;
    const line = prettyLine(
      { kind: "event", event: { ...item.event, actor: { id: "u_9" }, targets: [] } },
      batch,
    );
    expect(line).toMatch(/invoice\.paid by u_9 evt_/);
  });

  it("json: one object per line with stream + tenant; defaults to console.log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const batch = await makeBatch({ count: 1, checkpoint: true });
      await consoleSink({ format: "json" }).send(batch);
      expect(log).toHaveBeenCalledTimes(2);
      const parsed = log.mock.calls.map(
        ([l]) => JSON.parse(l as string) as Record<string, unknown>,
      );
      expect(parsed[0]).toMatchObject({ stream: "siem", tenant: "acme", kind: "event" });
      expect(parsed[1]).toMatchObject({ kind: "checkpoint", checkpoint: { seq: 1 } });
    } finally {
      log.mockRestore();
    }
  });
});

describe("fileSink / fileFallback", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audit-sinks-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends JSONL items, creating directories; path may depend on the batch", async () => {
    const sink = fileSink({ path: (b) => join(dir, "nested", `${b.tenant}.jsonl`) });
    await sink.send(await makeBatch({ count: 2 }));
    await sink.send(await makeBatch({ count: 1, checkpoint: true }));
    await sink.send({ stream: "s", tenant: "acme", items: [] });
    const lines = (await readFile(join(dir, "nested", "acme.jsonl"), "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as StreamItem).kind)).toEqual([
      "event",
      "event",
      "event",
      "checkpoint",
    ]);
  });

  it("static path without fsync", async () => {
    const path = join(dir, "out.jsonl");
    await fileSink({ path, fsync: false }).send(await makeBatch({ count: 1 }));
    expect((await readFile(path, "utf8")).split("\n")).toHaveLength(2);
  });

  it("fileFallback parks batches the recorder cannot persist; lines replay", async () => {
    const path = join(dir, "fallback", "audit.jsonl");
    const storage = createMemoryStorage();
    const broken = { ...storage, appendEvents: async () => Promise.reject(new Error("db down")) };
    const core = createAuditCore({ storage: broken, selfAudit: false });
    const onError = vi.fn();
    const recorder = createRecorder(core, {
      retry: { attempts: 0 },
      fallback: fileFallback(path, { fsync: false }),
      onError,
    });
    recorder.record({ tenant: "acme", action: "user.login", actor: { id: "u1" } });
    recorder.record({ tenant: "acme", action: "user.logout", actor: { id: "u1" } });
    await recorder.close();
    expect(onError).toHaveBeenCalledOnce();

    const lines = readFallbackLines(await readFile(path, "utf8"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      error: "db down",
      input: { tenant: "acme", action: "user.login" },
    });
    expect(Date.parse(lines[0]!.at)).not.toBeNaN();

    // Replay into a healthy core.
    const healthy = createAuditCore({ storage: createMemoryStorage(), selfAudit: false });
    const events = await healthy.recordMany(lines.map((l) => l.input));
    expect(events.map((e) => e.action)).toEqual(["user.login", "user.logout"]);
    expect(events[0]!.occurredAt).toBe(lines[0]!.input.occurredAt);
  });

  it("fileFallback stringifies non-Error causes and fsyncs by default", async () => {
    const path = join(dir, "fb.jsonl");
    await fileFallback(path).write([{ tenant: "t", action: "a", actor: { id: "x" } }], "boom");
    expect(readFallbackLines((await readFile(path, "utf8")) + "\n\n")[0]!.error).toBe("boom");
  });
});
