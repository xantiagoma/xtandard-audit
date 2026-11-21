import { describe, expect, it } from "vitest";
import { canonicalStringify } from "../src/canonical.ts";
import {
  GENESIS_HASH,
  base64urlDecode,
  base64urlEncode,
  chainHeader,
  computeDigests,
  ed25519Signer,
  ed25519VerificationKey,
  erasureIssues,
  generateSigningKeyPair,
  hmacSigner,
  hmacVerificationKey,
  jwkThumbprint,
  keysFromJwks,
  sealChain,
  sectionDigest,
  sha256,
  signCheckpoint,
  verifyChain,
  verifyCheckpointSignature,
  verifyEvent,
  type UnsealedEvent,
} from "../src/integrity.ts";
import type { AuditCheckpoint, AuditEvent } from "../src/schema.ts";

const base = (seq: number, overrides: Partial<UnsealedEvent> = {}): UnsealedEvent => ({
  id: `evt_01JD00000000000000000000${String(seq).padStart(2, "0")}`,
  tenant: "acme",
  seq,
  action: "invoice.paid",
  occurredAt: "2026-01-01T00:00:00.000Z",
  recordedAt: "2026-01-01T00:00:01.000Z",
  actor: { id: "u_1", name: "Ada" },
  targets: [{ type: "invoice", id: `inv_${seq}` }],
  context: { ip: "10.0.0.1" },
  metadata: { amount: seq * 100 },
  ...overrides,
});

async function chain(n: number): Promise<AuditEvent[]> {
  return sealChain(
    Array.from({ length: n }, (_, i) => base(i + 1)),
    GENESIS_HASH,
  );
}

describe("canonical JSON", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonicalStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("rejects non-finite numbers instead of writing null", () => {
    expect(() => canonicalStringify({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalStringify(Infinity)).toThrow(/non-finite/);
  });

  it("treats a top-level undefined as null", () => {
    expect(canonicalStringify(undefined)).toBe("null");
  });
});

describe("hashing primitives", () => {
  it("sha256 is prefixed lowercase hex", async () => {
    expect(await sha256("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("base64url round-trips", () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 1, 2, 3]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
    expect(base64urlEncode(bytes)).not.toMatch(/[+/=]/);
  });

  it("section digests are salted with the event id", async () => {
    const a = await sectionDigest("evt_A", { email: "ada@example.com" });
    const b = await sectionDigest("evt_B", { email: "ada@example.com" });
    expect(a).not.toBe(b);
    expect(a).toBe(await sectionDigest("evt_A", { email: "ada@example.com" }));
  });

  it("digests are independent of key order", async () => {
    const one = await computeDigests(base(1, { metadata: { a: 1, b: 2 } }));
    const two = await computeDigests(base(1, { metadata: { b: 2, a: 1 } }));
    expect(one).toEqual(two);
  });

  it("the chained header carries digests, not content", async () => {
    const e = base(1);
    const header = chainHeader(e, GENESIS_HASH, await computeDigests(e)) as Record<string, unknown>;
    expect(Object.keys(header).sort()).toEqual(
      [
        "action",
        "digests",
        "id",
        "occurredAt",
        "outcome",
        "prevHash",
        "recordedAt",
        "seq",
        "tenant",
        "v",
      ].sort(),
    );
    expect(JSON.stringify(header)).not.toContain("Ada");
  });
});

describe("verifyChain", () => {
  it("accepts an untouched chain anchored at genesis", async () => {
    const events = await chain(4);
    const report = await verifyChain(events);
    expect(report).toMatchObject({ ok: true, checked: 4, fromSeq: 1, toSeq: 4, anchor: "genesis" });
    expect(report.headHash).toBe(events[3]!.integrity.hash);
  });

  it("is order-insensitive in its input", async () => {
    const events = await chain(3);
    expect((await verifyChain([...events].reverse())).ok).toBe(true);
  });

  it("detects an edited section", async () => {
    const events = await chain(3);
    events[1] = { ...events[1]!, metadata: { amount: 1 } };
    const report = await verifyChain(events);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "digest-mismatch", seq: 2, section: "metadata" }),
    ]);
  });

  it("detects an edited header field", async () => {
    const events = await chain(3);
    events[2] = { ...events[2]!, action: "invoice.voided" };
    const kinds = (await verifyChain(events)).issues.map((i) => i.kind);
    expect(kinds).toEqual(["hash-mismatch"]);
  });

  it("detects a deleted event (seq gap) and a re-linked chain", async () => {
    const events = await chain(4);
    const gap = await verifyChain([events[0]!, events[1]!, events[3]!]);
    expect(gap.issues.map((i) => i.kind)).toEqual(["seq-gap"]);

    // Re-sealing a forged event at seq 2 breaks the link to seq 3.
    const [forged] = await sealChain(
      [base(2, { metadata: { amount: 0 } })],
      events[0]!.integrity.hash,
    );
    const relinked = await verifyChain([events[0]!, forged!, events[2]!, events[3]!]);
    expect(relinked.issues.map((i) => i.kind)).toEqual(["link-mismatch"]);
  });

  it("checks events individually for non-contiguous subsets", async () => {
    const events = await chain(5);
    const report = await verifyChain([events[0]!, events[4]!], { contiguous: false });
    expect(report).toMatchObject({ ok: true, linksChecked: false });
  });

  it("flags events of another tenant", async () => {
    const events = await chain(2);
    const [other] = await sealChain([base(3, { tenant: "globex" })], events[1]!.integrity.hash);
    expect((await verifyChain([...events, other!])).issues.map((i) => i.kind)).toEqual([
      "tenant-mismatch",
    ]);
  });

  it("reports a missing integrity block as malformed", async () => {
    const events = await chain(1);
    const broken = { ...events[0]!, integrity: undefined } as unknown as AuditEvent;
    expect((await verifyEvent(broken)).map((i) => i.kind)).toEqual(["malformed"]);
  });

  it("marks a range not starting at genesis as unanchored", async () => {
    const events = await chain(3);
    expect((await verifyChain(events.slice(1))).anchor).toBe("unanchored");
    expect((await verifyChain([])).anchor).toBe("none");
  });
});

describe("checkpoints", () => {
  it("Ed25519: sign, publish the JWKS, verify", async () => {
    const pair = await generateSigningKeyPair();
    expect(pair.keyId).toBe((await jwkThumbprint(pair.publicJwk)).slice(0, 16));
    const signer = await ed25519Signer(pair.privateJwk);
    expect(signer.keyId).toBe(pair.keyId);
    const events = await chain(3);
    const cp = await signCheckpoint(signer, {
      v: 1,
      id: "chk_1",
      tenant: "acme",
      kind: "head",
      seq: 3,
      hash: events[2]!.integrity.hash,
      at: "2026-01-01T00:00:02.000Z",
    });
    expect(cp).toMatchObject({ alg: "Ed25519", keyId: pair.keyId });
    const jwk = await signer.publicJwk!();
    expect(jwk).not.toHaveProperty("d");
    const keys = await keysFromJwks({ keys: [jwk!] });
    expect(await verifyCheckpointSignature(cp, keys[0]!)).toBe(true);

    const report = await verifyChain(events, { checkpoints: [cp], keys });
    expect(report).toMatchObject({ ok: true, checkpointsVerified: 1, signedThrough: 3 });
  });

  it("rejects a forged or mismatching checkpoint", async () => {
    const signer = hmacSigner("secret", { keyId: "k1" });
    const events = await chain(3);
    const good = await signCheckpoint(signer, {
      v: 1,
      id: "chk_1",
      tenant: "acme",
      kind: "head",
      seq: 2,
      hash: events[1]!.integrity.hash,
      at: "2026-01-01T00:00:02.000Z",
    });
    const keys = [hmacVerificationKey("secret", "k1")];
    const tampered: AuditCheckpoint = { ...good, seq: 3 };
    const wrongHash = await signCheckpoint(signer, { ...good, id: "chk_2", hash: GENESIS_HASH });
    const unknownKey = await signCheckpoint(hmacSigner("other", { keyId: "k2" }), {
      ...good,
      id: "chk_3",
    });

    const report = await verifyChain(events, {
      checkpoints: [tampered, wrongHash, unknownKey],
      keys,
    });
    expect(report.issues.map((i) => i.kind).sort()).toEqual(
      ["bad-signature", "checkpoint-mismatch", "unknown-key"].sort(),
    );
    expect(await verifyCheckpointSignature({ ...good, signature: "!!" }, keys[0]!)).toBe(false);
  });

  it("a head checkpoint right before the range anchors it; a broken anchor is reported", async () => {
    const signer = hmacSigner("s");
    const keys = [await signer.verificationKey()];
    const events = await chain(4);
    const anchor = await signCheckpoint(signer, {
      v: 1,
      id: "chk_1",
      tenant: "acme",
      kind: "head",
      seq: 2,
      hash: events[1]!.integrity.hash,
      at: "2026-01-01T00:00:00.000Z",
    });
    const tail = events.slice(2);
    expect(await verifyChain(tail, { checkpoints: [anchor], keys })).toMatchObject({
      ok: true,
      anchor: "checkpoint",
    });
    const bad = await signCheckpoint(signer, { ...anchor, id: "chk_2", hash: GENESIS_HASH });
    expect((await verifyChain(tail, { checkpoints: [bad], keys })).issues[0]!.kind).toBe(
      "checkpoint-mismatch",
    );
  });

  it("a base checkpoint anchors a pruned prefix", async () => {
    const signer = hmacSigner("s");
    const keys = [await signer.verificationKey()];
    const events = await chain(4);
    const baseCp = await signCheckpoint(signer, {
      v: 1,
      id: "chk_b",
      tenant: "acme",
      kind: "base",
      seq: 2,
      hash: events[1]!.integrity.hash,
      at: "2026-01-01T00:00:00.000Z",
    });
    expect((await verifyChain(events.slice(2), { checkpoints: [baseCp], keys })).anchor).toBe(
      "checkpoint",
    );
    const wrong = { ...baseCp, hash: GENESIS_HASH };
    const signedWrong = await signCheckpoint(signer, wrong);
    expect(
      (await verifyChain(events.slice(2), { checkpoints: [signedWrong], keys })).issues[0]!.kind,
    ).toBe("checkpoint-mismatch");
  });

  it("verification keys from public JWKs ignore non-Ed25519 keys", async () => {
    const pair = await generateSigningKeyPair();
    const keys = await keysFromJwks({ keys: [pair.publicJwk, { kty: "RSA", n: "x", e: "AQAB" }] });
    expect(keys).toHaveLength(1);
    const k = await ed25519VerificationKey({ ...pair.publicJwk, kid: undefined });
    expect(k.keyId).toBe(pair.keyId);
  });
});

describe("erasure justification", () => {
  it("requires an audit_log.erased record covering every erased section", async () => {
    const erased = [{ seq: 1, eventId: "evt_1", sections: ["actor", "metadata"] as const }].map(
      (e) => ({ ...e, sections: [...e.sections] }),
    );
    const justification = (sections: string[]) =>
      ({
        action: "audit_log.erased",
        metadata: { eventId: "evt_1", sections },
      }) as unknown as AuditEvent;
    expect(erasureIssues(erased, [justification(["actor", "metadata"])])).toEqual([]);
    expect(erasureIssues(erased, [justification(["actor"])])[0]).toMatchObject({
      kind: "unjustified-erasure",
      section: "metadata",
    });
    expect(erasureIssues(erased, [])).toHaveLength(1);
  });
});
