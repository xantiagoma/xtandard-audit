/**
 * Tamper evidence (ADR 0004): per-tenant hash chains with salted per-section
 * digests, signed checkpoints, and a pure verifier.
 *
 * ```txt
 * digest(section) = "sha256:" + hex(SHA-256(id + "\n" + canonical(section)))
 * header          = { v, id, tenant, seq, action, occurredAt, recordedAt,
 *                     outcome, prevHash, digests }
 * hash            = "sha256:" + hex(SHA-256(canonical(header)))
 * ```
 *
 * Zero dependencies — Web Crypto only — so it runs in Bun, Node ≥ 20, Deno,
 * browsers and Workers, and is what an auditor runs (`@xtandard/audit/verify`).
 *
 * @module
 */

import { canonicalStringify } from "./canonical.ts";
import type {
  AuditCheckpoint,
  AuditEvent,
  AuditIntegrity,
  AuditSection,
  JsonValue,
} from "./schema.ts";
import { AUDIT_SECTIONS } from "./schema.ts";

/** `prevHash` of the first event of every chain. */
export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `"sha256:" + hex(SHA-256(utf8(text)))`. */
export async function sha256(text: string): Promise<string> {
  return `sha256:${toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)))}`;
}

/** base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url (with or without padding). */
export function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** An event before it is sealed into the chain. */
export type UnsealedEvent = Omit<AuditEvent, "integrity">;

/** The JSON value of one section of an event, as hashed. */
export function sectionValue(event: UnsealedEvent, section: AuditSection): JsonValue {
  switch (section) {
    case "actor":
      return event.actor as unknown as JsonValue;
    case "targets":
      return event.targets as unknown as JsonValue;
    case "context":
      return event.context as unknown as JsonValue;
    case "metadata":
      return event.metadata;
    case "description":
      return event.description ?? null;
  }
}

/** Salted digest of one section's value. */
export function sectionDigest(eventId: string, value: JsonValue): Promise<string> {
  return sha256(`${eventId}\n${canonicalStringify(value)}`);
}

/** Compute every section digest of an (unerased) event. */
export async function computeDigests(event: UnsealedEvent): Promise<Record<AuditSection, string>> {
  const entries = await Promise.all(
    AUDIT_SECTIONS.map(
      async (s) => [s, await sectionDigest(event.id, sectionValue(event, s))] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<AuditSection, string>;
}

/** The chained header for an event (what `hash` is computed over). */
export function chainHeader(
  event: UnsealedEvent,
  prevHash: string,
  digests: Record<AuditSection, string>,
): JsonValue {
  return {
    v: 1,
    id: event.id,
    tenant: event.tenant,
    seq: event.seq,
    action: event.action,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    outcome: event.outcome ?? null,
    prevHash,
    digests,
  };
}

/** Seal an event: compute its digests and its chain hash linked to `prevHash`. */
export async function sealEvent(event: UnsealedEvent, prevHash: string): Promise<AuditEvent> {
  const digests = await computeDigests(event);
  const hash = await sha256(canonicalStringify(chainHeader(event, prevHash, digests)));
  const integrity: AuditIntegrity = { v: 1, prevHash, hash, digests };
  return { ...event, integrity };
}

/** Seal a batch for one tenant, linking each event to the previous one. */
export async function sealChain(events: UnsealedEvent[], prevHash: string): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  let prev = prevHash;
  for (const e of events) {
    const sealed = await sealEvent(e, prev);
    out.push(sealed);
    prev = sealed.integrity.hash;
  }
  return out;
}

// ---- verification ------------------------------------------------------------------------------

/** Why verification failed at a given point. */
export type VerifyIssueKind =
  | "digest-mismatch"
  | "hash-mismatch"
  | "link-mismatch"
  | "seq-gap"
  | "tenant-mismatch"
  | "bad-signature"
  | "checkpoint-mismatch"
  | "unknown-key"
  | "unjustified-erasure"
  | "malformed";

/** One verification failure. */
export interface VerifyIssue {
  kind: VerifyIssueKind;
  seq?: number;
  eventId?: string;
  checkpointId?: string;
  section?: AuditSection;
  message: string;
}

/** Result of {@link verifyChain}. */
export interface VerifyReport {
  /** True when no issue was found. */
  ok: boolean;
  tenant: string | null;
  /** Events checked. */
  checked: number;
  /** First and last seq checked (null when empty). */
  fromSeq: number | null;
  toSeq: number | null;
  /** Hash of the last checked event. */
  headHash: string | null;
  /**
   * How the start of the range is anchored: `"genesis"` (seq 1),
   * `"checkpoint"` (a verified checkpoint covers `fromSeq - 1`, or a `base`
   * checkpoint), or `"unanchored"` (the first `prevHash` is trusted as given).
   */
  anchor: "genesis" | "checkpoint" | "unanchored" | "none";
  /** Whether links between events were checked (false for non-contiguous subsets). */
  linksChecked: boolean;
  /** Checkpoints whose signature and hash were verified. */
  checkpointsVerified: number;
  /**
   * The highest seq covered by a verified checkpoint, or null. Events after it
   * are internally consistent but not yet anchored by a signature.
   */
  signedThrough: number | null;
  /** Sections reported as erased (content removed, digest kept). */
  erased: { seq: number; eventId: string; sections: AuditSection[] }[];
  issues: VerifyIssue[];
}

/** A key able to verify checkpoint signatures. */
export interface AuditVerificationKey {
  keyId: string;
  alg: AuditCheckpoint["alg"];
  verify(data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/** Options for {@link verifyChain}. */
export interface VerifyChainOptions {
  /** Checkpoints to check against the events (and whose signatures to verify). */
  checkpoints?: AuditCheckpoint[];
  /** Keys to verify checkpoint signatures with. Without keys, signatures are not checked. */
  keys?: AuditVerificationKey[];
  /**
   * Treat the events as a contiguous range (default `true`): check seq
   * continuity and `prevHash` links. Set `false` for filtered subsets — each
   * event is then verified on its own.
   */
  contiguous?: boolean;
  /**
   * Require every erased section to be justified by a chained
   * `audit_log.erased` event (default `true`). The `erased` list itself is not
   * covered by the hash, so this is what stops "erase" from being a way to
   * silently replace content (ADR 0011). Set `false` when verifying a range
   * that ends before the erasure records, or when self-audit is disabled.
   */
  requireErasureRecords?: boolean;
}

/** Re-derive one event's digests and hash; returns the issues found. */
export async function verifyEvent(event: AuditEvent): Promise<VerifyIssue[]> {
  const issues: VerifyIssue[] = [];
  const integrity = event.integrity;
  if (!integrity || integrity.v !== 1 || !integrity.digests) {
    return [
      { kind: "malformed", seq: event.seq, eventId: event.id, message: "missing integrity block" },
    ];
  }
  const erased = new Set(integrity.erased ?? []);
  for (const s of AUDIT_SECTIONS) {
    if (erased.has(s)) continue;
    const digest = await sectionDigest(event.id, sectionValue(event, s));
    if (digest !== integrity.digests[s]) {
      issues.push({
        kind: "digest-mismatch",
        seq: event.seq,
        eventId: event.id,
        section: s,
        message: `section "${s}" of seq ${event.seq} does not match its digest`,
      });
    }
  }
  const hash = await sha256(
    canonicalStringify(chainHeader(event, integrity.prevHash, integrity.digests)),
  );
  if (hash !== integrity.hash) {
    issues.push({
      kind: "hash-mismatch",
      seq: event.seq,
      eventId: event.id,
      message: `header of seq ${event.seq} does not match its hash`,
    });
  }
  return issues;
}

/**
 * Verify a tenant's events (and optionally checkpoints). Pure: it trusts
 * nothing but the data passed in and the keys.
 *
 * @example
 * ```ts
 * import { verifyChain, keysFromJwks } from "@xtandard/audit/verify";
 *
 * const report = await verifyChain(events, {
 *   checkpoints,
 *   keys: await keysFromJwks(jwks),
 * });
 * if (!report.ok) console.error(report.issues);
 * ```
 */
export async function verifyChain(
  events: AuditEvent[],
  options: VerifyChainOptions = {},
): Promise<VerifyReport> {
  const contiguous = options.contiguous ?? true;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const issues: VerifyIssue[] = [];
  const erased: VerifyReport["erased"] = [];
  const tenant = sorted[0]?.tenant ?? options.checkpoints?.[0]?.tenant ?? null;

  const bySeq = new Map<number, AuditEvent>();
  let prev: AuditEvent | null = null;
  for (const event of sorted) {
    if (event.tenant !== tenant) {
      issues.push({
        kind: "tenant-mismatch",
        seq: event.seq,
        eventId: event.id,
        message: `event ${event.id} belongs to tenant "${event.tenant}", not "${tenant}"`,
      });
      continue;
    }
    bySeq.set(event.seq, event);
    issues.push(...(await verifyEvent(event)));
    if (event.integrity?.erased?.length) {
      erased.push({ seq: event.seq, eventId: event.id, sections: [...event.integrity.erased] });
    }
    if (contiguous && prev) {
      if (event.seq !== prev.seq + 1) {
        issues.push({
          kind: "seq-gap",
          seq: event.seq,
          eventId: event.id,
          message: `seq jumps from ${prev.seq} to ${event.seq}`,
        });
      } else if (event.integrity?.prevHash !== prev.integrity?.hash) {
        issues.push({
          kind: "link-mismatch",
          seq: event.seq,
          eventId: event.id,
          message: `seq ${event.seq} does not link to seq ${prev.seq}`,
        });
      }
    }
    prev = event;
  }

  if ((options.requireErasureRecords ?? true) && erased.length > 0) {
    issues.push(...erasureIssues(erased, [...bySeq.values()]));
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let anchor: VerifyReport["anchor"] = "none";
  if (first) {
    anchor =
      first.seq === 1 && first.integrity?.prevHash === GENESIS_HASH ? "genesis" : "unanchored";
  }

  // Checkpoints: verify signatures, then match them against the events we hold.
  let checkpointsVerified = 0;
  let signedThrough: number | null = null;
  const keys = options.keys;
  for (const cp of options.checkpoints ?? []) {
    if (tenant !== null && cp.tenant !== tenant) continue;
    if (keys) {
      const key = keys.find((k) => k.keyId === cp.keyId && k.alg === cp.alg);
      if (!key) {
        issues.push({
          kind: "unknown-key",
          checkpointId: cp.id,
          seq: cp.seq,
          message: `checkpoint ${cp.id} is signed by unknown key "${cp.keyId}"`,
        });
        continue;
      }
      if (!(await verifyCheckpointSignature(cp, key))) {
        issues.push({
          kind: "bad-signature",
          checkpointId: cp.id,
          seq: cp.seq,
          message: `checkpoint ${cp.id} has an invalid signature`,
        });
        continue;
      }
    }
    let matched = false;
    if (cp.kind === "head") {
      const event = bySeq.get(cp.seq);
      if (event) {
        matched = true;
        if (event.integrity?.hash !== cp.hash) {
          issues.push({
            kind: "checkpoint-mismatch",
            checkpointId: cp.id,
            seq: cp.seq,
            message: `checkpoint ${cp.id} signs a different hash for seq ${cp.seq}`,
          });
          continue;
        }
      }
      // A head checkpoint right before the range anchors its start.
      if (first && cp.seq === first.seq - 1) {
        matched = true;
        if (first.integrity?.prevHash === cp.hash) anchor = "checkpoint";
        else {
          issues.push({
            kind: "checkpoint-mismatch",
            checkpointId: cp.id,
            seq: cp.seq,
            message: `seq ${first.seq} does not link to checkpoint ${cp.id}`,
          });
          continue;
        }
      }
    } else if (first && cp.seq === first.seq - 1) {
      // base: anchors a pruned prefix.
      matched = true;
      if (first.integrity?.prevHash === cp.hash) anchor = "checkpoint";
      else {
        issues.push({
          kind: "checkpoint-mismatch",
          checkpointId: cp.id,
          seq: cp.seq,
          message: `first retained seq ${first.seq} does not link to base checkpoint ${cp.id}`,
        });
        continue;
      }
    }
    if (matched && keys) {
      checkpointsVerified++;
      if (cp.kind === "head" && bySeq.has(cp.seq)) {
        signedThrough = Math.max(signedThrough ?? 0, cp.seq);
      }
    }
  }

  return {
    ok: issues.length === 0,
    tenant,
    checked: sorted.length,
    fromSeq: first?.seq ?? null,
    toSeq: last?.seq ?? null,
    headHash: last?.integrity?.hash ?? null,
    anchor,
    linksChecked: contiguous,
    checkpointsVerified,
    signedThrough,
    erased,
    issues,
  };
}

/**
 * Check that every erased section is justified by a chained `audit_log.erased`
 * event among `events` (ADR 0011).
 */
export function erasureIssues(
  erased: VerifyReport["erased"],
  events: Iterable<AuditEvent>,
): VerifyIssue[] {
  const justified = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.action !== "audit_log.erased") continue;
    const id = e.metadata?.eventId;
    const sections = e.metadata?.sections;
    if (typeof id !== "string" || !Array.isArray(sections)) continue;
    const set = justified.get(id) ?? new Set<string>();
    for (const sec of sections) if (typeof sec === "string") set.add(sec);
    justified.set(id, set);
  }
  const issues: VerifyIssue[] = [];
  for (const entry of erased) {
    const set = justified.get(entry.eventId);
    const missing = entry.sections.filter((sec) => !set?.has(sec));
    if (missing.length > 0) {
      issues.push({
        kind: "unjustified-erasure",
        seq: entry.seq,
        eventId: entry.eventId,
        section: missing[0]!,
        message: `seq ${entry.seq} has erased section(s) ${missing.join(", ")} with no audit_log.erased record`,
      });
    }
  }
  return issues;
}

// ---- checkpoints + signers ---------------------------------------------------------------------

/** Signs checkpoints. Implement your own (KMS, HSM) or use the built-ins. */
export interface AuditSigner {
  keyId: string;
  alg: AuditCheckpoint["alg"];
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** The public verification key as a JWK (asymmetric signers only), for the JWKS route. */
  publicJwk?(): Promise<JsonWebKey | null>;
  /** A verification key for this signer (used by `core.verify`). */
  verificationKey(): Promise<AuditVerificationKey>;
}

/** The bytes a checkpoint signature covers: canonical JSON of everything but `signature`. */
export function checkpointSigningBytes(cp: Omit<AuditCheckpoint, "signature">): Uint8Array {
  const { signature: _signature, ...rest } = cp as AuditCheckpoint;
  return encoder.encode(canonicalStringify(rest as unknown as JsonValue));
}

/** Sign an unsigned checkpoint. */
export async function signCheckpoint(
  signer: AuditSigner,
  unsigned: Omit<AuditCheckpoint, "signature" | "keyId" | "alg">,
): Promise<AuditCheckpoint> {
  const body = { ...unsigned, keyId: signer.keyId, alg: signer.alg };
  const signature = base64urlEncode(await signer.sign(checkpointSigningBytes(body)));
  return { ...body, signature };
}

/** Verify one checkpoint's signature with a key. */
export async function verifyCheckpointSignature(
  cp: AuditCheckpoint,
  key: AuditVerificationKey,
): Promise<boolean> {
  try {
    return await key.verify(checkpointSigningBytes(cp), base64urlDecode(cp.signature));
  } catch {
    return false;
  }
}

/** RFC 7638 JWK thumbprint (base64url SHA-256) of an Ed25519 public key. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return base64urlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical))),
  );
}

/** A JWK with its key id. */
export type AuditJwk = JsonWebKey & { kid?: string };

/** Generate an Ed25519 key pair as JWKs (store `privateJwk` as a secret). */
export async function generateSigningKeyPair(): Promise<{
  keyId: string;
  privateJwk: AuditJwk;
  publicJwk: AuditJwk;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk: AuditJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk: AuditJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const keyId = (await jwkThumbprint(publicJwk)).slice(0, 16);
  return {
    keyId,
    privateJwk: { ...privateJwk, kid: keyId },
    publicJwk: { ...publicJwk, kid: keyId },
  };
}

function publicPart(jwk: AuditJwk): AuditJwk {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.kid ? { kid: jwk.kid } : {}) };
}

/** A verification key from an Ed25519 public JWK. */
export async function ed25519VerificationKey(
  jwk: AuditJwk,
  keyId?: string,
): Promise<AuditVerificationKey> {
  const pub = publicPart(jwk);
  const key = await crypto.subtle.importKey("jwk", pub, { name: "Ed25519" }, false, ["verify"]);
  return {
    keyId: keyId ?? jwk.kid ?? (await jwkThumbprint(pub)).slice(0, 16),
    alg: "Ed25519",
    verify: async (data, signature) =>
      crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        signature as BufferSource,
        data as BufferSource,
      ),
  };
}

/**
 * An Ed25519 signer from a private JWK (from {@link generateSigningKeyPair} or
 * `xtandard-audit keygen`). The public half is served as a JWKS so customers
 * can verify checkpoints themselves.
 *
 * @example
 * ```ts
 * import { ed25519Signer } from "@xtandard/audit";
 *
 * const signer = await ed25519Signer(JSON.parse(process.env.AUDIT_SIGNING_KEY!));
 * ```
 */
export async function ed25519Signer(
  privateJwk: AuditJwk,
  options: { keyId?: string } = {},
): Promise<AuditSigner> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, [
    "sign",
  ]);
  const pub = publicPart(privateJwk);
  const keyId = options.keyId ?? privateJwk.kid ?? (await jwkThumbprint(pub)).slice(0, 16);
  return {
    keyId,
    alg: "Ed25519",
    sign: async (data) =>
      new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, data as BufferSource)),
    publicJwk: async () => ({ ...pub, kid: keyId, alg: "Ed25519", use: "sig" }) as JsonWebKey,
    verificationKey: () => ed25519VerificationKey(pub, keyId),
  };
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** A verification key for {@link hmacSigner} checkpoints (needs the secret). */
export function hmacVerificationKey(secret: string, keyId = "hmac"): AuditVerificationKey {
  return {
    keyId,
    alg: "HS256",
    verify: async (data, signature) =>
      crypto.subtle.verify(
        "HMAC",
        await hmacKey(secret, "verify"),
        signature as BufferSource,
        data as BufferSource,
      ),
  };
}

/**
 * A symmetric HMAC-SHA256 signer: simplest setup, but only holders of the
 * secret can verify — prefer {@link ed25519Signer} when customers verify.
 */
export function hmacSigner(secret: string, options: { keyId?: string } = {}): AuditSigner {
  const keyId = options.keyId ?? "hmac";
  return {
    keyId,
    alg: "HS256",
    sign: async (data) =>
      new Uint8Array(
        await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), data as BufferSource),
      ),
    publicJwk: async () => null,
    verificationKey: async () => hmacVerificationKey(secret, keyId),
  };
}

/** Verification keys from a JWKS document (`GET {basePath}/api/integrity/keys`). */
export async function keysFromJwks(jwks: { keys: AuditJwk[] }): Promise<AuditVerificationKey[]> {
  return Promise.all(
    jwks.keys
      .filter((k) => k.kty === "OKP" && k.crv === "Ed25519")
      .map((k) => ed25519VerificationKey(k)),
  );
}
