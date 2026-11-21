/**
 * The zero-dependency verifier for auditors and customers: re-derive every hash
 * of an exported log, check its links, and verify the signed checkpoints, with
 * nothing but Web Crypto (ADR 0004).
 *
 * @example
 * ```ts
 * import { verifyBundle } from "@xtandard/audit/verify";
 *
 * const report = await verifyBundle(await Bun.file("acme.audit.jsonl").text());
 * console.log(report.ok ? `verified ${report.checked} events` : report.issues);
 * ```
 *
 * Import from `@xtandard/audit/verify`.
 *
 * @module verify
 */

export {
  GENESIS_HASH,
  verifyChain,
  verifyEvent,
  verifyCheckpointSignature,
  keysFromJwks,
  ed25519VerificationKey,
  hmacVerificationKey,
  sha256,
  type AuditVerificationKey,
  type VerifyChainOptions,
  type VerifyIssue,
  type VerifyIssueKind,
  type VerifyReport,
} from "./integrity.ts";
export { canonicalStringify } from "./canonical.ts";
export { parseBundle, verifyBundle, type BundleHeader, type ParsedBundle } from "./export.ts";
export type { AuditCheckpoint, AuditEvent } from "./schema.ts";
