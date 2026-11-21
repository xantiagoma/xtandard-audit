import { describe, expect, it } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { CSV_COLUMNS, csvCell, exportEvents, parseBundle, verifyBundle } from "../src/export.ts";
import { HookDeniedError } from "../src/hooks/contract.ts";
import { ed25519Signer, generateSigningKeyPair, keysFromJwks } from "../src/integrity.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

async function seeded() {
  const pair = await generateSigningKeyPair();
  const audit = createAuditCore({
    storage: createMemoryStorage(),
    signer: await ed25519Signer(pair.privateJwk),
    checkpoints: { every: 2 },
  });
  await audit.record({
    tenant: "acme",
    action: "invoice.paid",
    actor: { id: "u_1", name: "Ada, Countess", email: "ada@example.com" },
    targets: [{ type: "invoice", id: "inv_1" }],
    context: { ip: "1.2.3.4", userAgent: "UA", requestId: "r1" },
    metadata: { amount: 10, note: 'says "hi"' },
    description: '=HYPERLINK("http://evil")',
  });
  await audit.record({ tenant: "acme", action: "user.login", actor: { id: "u_2" } });
  await audit.record({ tenant: "acme", action: "user.login", actor: { id: "u_3" } });
  await audit.settled();
  return { audit, pair };
}

const text = (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe("exportEvents", () => {
  it("CSV: header, quoting and formula neutralization", async () => {
    const { audit } = await seeded();
    const csv = await text(
      await exportEvents(audit, { tenant: "acme", order: "asc" }, { format: "csv" }),
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    // 3 events + the export's own self-audit record (written before streaming starts).
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain("audit_log.exported");
    expect(lines[1]).toContain('"Ada, Countess"');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell(null)).toBe("");
  });

  it("JSON and JSONL honour the query and the max", async () => {
    const { audit } = await seeded();
    const json = JSON.parse(
      await text(
        await exportEvents(audit, { tenant: "acme", actions: ["user.*"] }, { format: "json" }),
      ),
    );
    expect(json.map((e: { action: string }) => e.action)).toEqual(["user.login", "user.login"]);
    const jsonl = await text(
      await exportEvents(audit, { tenant: "acme" }, { format: "jsonl", maxEvents: 2 }),
    );
    expect(jsonl.trim().split("\n")).toHaveLength(2);
    expect(
      JSON.parse(await text(await exportEvents(audit, { tenant: "nobody" }, { format: "json" }))),
    ).toEqual([]);
  });

  it("is self-audited, hook-gated, and requires a tenant", async () => {
    const { audit } = await seeded();
    await text(
      await exportEvents(audit, { tenant: "acme" }, { format: "jsonl", actor: { id: "op" } }),
    );
    const [note] = (await audit.query({ tenant: "acme", actions: ["audit_log.exported"] })).items;
    expect(note).toMatchObject({ actor: { id: "op" }, metadata: { format: "jsonl" } });
    await expect(exportEvents(audit, {}, { format: "csv" })).rejects.toThrow(/query.tenant/);
    const gated = createAuditCore({
      storage: createMemoryStorage(),
      hooks: {
        before: (e) => {
          if (e.type === "events.export") throw new HookDeniedError("no");
        },
      },
    });
    await expect(exportEvents(gated, { tenant: "x" }, { format: "csv" })).rejects.toThrow("no");
  });
});

describe("verifiable bundles", () => {
  it("round-trip offline with the bundled JWKS or independent keys", async () => {
    const { audit, pair } = await seeded();
    const bundle = await text(await exportEvents(audit, { tenant: "acme" }, { format: "bundle" }));
    const parsed = parseBundle(bundle);
    expect(parsed.header).toMatchObject({
      format: "xtandard-audit-bundle",
      tenant: "acme",
      fromSeq: 1,
    });
    expect(parsed.events.length).toBe(parsed.header.toSeq);
    expect(parsed.checkpoints.length).toBeGreaterThan(0);
    const report = await verifyBundle(bundle);
    expect(report).toMatchObject({ ok: true, anchor: "genesis" });
    expect(report.signedThrough).toBeGreaterThan(0);
    const keys = await keysFromJwks({ keys: [pair.publicJwk] });
    expect((await verifyBundle(bundle, { keys })).ok).toBe(true);
  });

  it("detect tampering, truncation and foreign keys", async () => {
    const { audit } = await seeded();
    const bundle = await text(await exportEvents(audit, { tenant: "acme" }, { format: "bundle" }));
    const tampered = bundle.replace('"amount":10', '"amount":11');
    expect((await verifyBundle(tampered)).issues.map((i) => i.kind)).toContain("digest-mismatch");

    const lines = bundle.trim().split("\n");
    const lastEvent = lines.map((l) => JSON.parse(l).type).lastIndexOf("event");
    const truncated = lines.filter((_, i) => i !== lastEvent).join("\n");
    expect((await verifyBundle(truncated)).issues.map((i) => i.kind)).toContain("seq-gap");

    const other = await generateSigningKeyPair();
    const foreign = await verifyBundle(bundle, {
      keys: await keysFromJwks({ keys: [other.publicJwk] }),
    });
    expect(foreign.issues.map((i) => i.kind)).toContain("unknown-key");
  });

  it("anchor a pruned log with its base", async () => {
    const pair = await generateSigningKeyPair();
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      signer: await ed25519Signer(pair.privateJwk),
      checkpoints: false,
      retention: { keepLast: 2 },
    });
    for (let i = 0; i < 5; i++)
      await audit.record({ tenant: "p", action: "x", actor: { id: "u" } });
    await audit.prune();
    const bundle = await text(await exportEvents(audit, { tenant: "p" }, { format: "bundle" }));
    const report = await verifyBundle(bundle);
    expect(report).toMatchObject({ ok: true, anchor: "checkpoint" });
    expect(report.bundle.baseHash).toMatch(/^sha256:/);
    const relinked = bundle.replace(report.bundle.baseHash!, "sha256:" + "1".repeat(64));
    expect((await verifyBundle(relinked)).ok).toBe(false);
  });

  it("parseBundle rejects garbage", () => {
    expect(() => parseBundle("not json")).toThrow(/not JSON/);
    expect(() => parseBundle('{"type":"event"}')).toThrow(/missing header/);
  });
});
