# ADR 0004 — Tamper Evidence: Per-Tenant Hash Chain, Sectioned Digests, Signed Checkpoints

**Status:** Accepted (★ new: no sibling equivalent)

---

## Context

The differentiator of an audit log over "a table with a `created_at`" is that a customer or an
auditor can **check** that nobody — including the operator — altered, removed or reordered events.
The research ([landscape](../research/landscape.md), "Tamper-evidence designs") shows the spectrum:

- **Per-event hashes** (Retraced-style): detect edits of one event, not deletions or reordering.
- **Hash chains** (each entry commits to the previous one): detect edits, deletions and reordering
  inside the chain; tail truncation and full rewrites need an external anchor.
- **Merkle-tree transparency logs** (Trillian, Tessera, Rekor, C2SP checkpoints): efficient
  inclusion/consistency proofs for many independent verifiers; heavier machinery (tiles, witnesses).
- **Signed batches / checkpoints**: a signature over the current head binds the log at a point in
  time; publishing it to the customer makes a later rewrite detectable.

Constraints: must run on every storage driver (including plain KV), on the record hot path, inside a
library, with a verifier simple enough for a customer's auditor to run, and must coexist with
retention and GDPR erasure (ADR 0011).

## Decision

1. **One hash chain per tenant.** Each event gets a contiguous `seq` (1, 2, 3, …) and an
   `integrity` block `{ v: 1, prevHash, hash, digests }`.
2. **Sectioned digests.** The privacy-bearing sections (`actor`, `targets`, `context`, `metadata`,
   `description`) are each hashed separately:
   `digest(section) = "sha256:" + hex(SHA-256(id + "\n" + canonical(section)))` (salted with the
   event id so low-entropy content cannot be confirmed by brute force after erasure, ADR 0011). The chained **header** is
   `{ v, id, tenant, seq, action, occurredAt, recordedAt, outcome, prevHash, digests }` and
   `hash = "sha256:" + hex(SHA-256(canonical(header)))`. Seq 1 links to the genesis value
   `sha256:` + 64 zeros. `canonical` = JSON with object keys sorted at every depth, no whitespace
   (RFC 8785 for the value shapes we accept: strings, finite numbers, booleans, null, arrays,
   objects).
3. **Signed checkpoints.** A checkpoint is `{ v, tenant, seq, hash, at, keyId, alg, signature }`
   over the canonical form of everything but `signature`, signed by a pluggable `AuditSigner`:
   `ed25519Signer` (default recommendation: verifiable with a published public key, served as a JWKS
   at `/api/integrity/keys`) or `hmacSigner` (symmetric, for internal-only verification). Checkpoints
   are created on demand (`core.checkpoint(tenant)`), automatically (`checkpoints: { every, interval }`),
   and on every retention prune (a `base` checkpoint anchoring the new first retained event).
4. **Checkpoints are streamed** to sinks like events (ADR 0008), so a tenant can keep its own copy
   of signed heads — the lightweight version of transparency-log witnesses. An operator rewrite is
   then detectable against the tenant's copy.
5. **Verification is a pure function**, `verifyChain(events, { checkpoints, keys, base })`, shipped
   on the zero-dependency `@xtandard/audit/verify` subpath (Web Crypto only), behind
   `core.verify(tenant, range)`, the `GET /api/tenants/:t/verify` route, the viewer's "Verify"
   button, and `xtandard-audit verify --bundle export.jsonl`. It reports the first break precisely
   (`hash-mismatch`, `seq-gap`, `link-mismatch`, `digest-mismatch`, `bad-signature`,
   `checkpoint-mismatch`) and which tail is not yet covered by a checkpoint.
6. **Verifiable exports.** The JSONL export bundle is `header line + events + checkpoints (+ base)`,
   so an exported log can be verified offline with nothing but the bundle and the public key.
7. **Concurrency.** Appends to one tenant are serialized in-process (per-tenant mutex) and guarded
   across processes by the storage: native event-log drivers enforce `UNIQUE(tenant, seq)` and the
   core re-chains and retries on conflict; KV drivers use `compareAndSwap` on the chain head when the
   storage has it, and otherwise assume a single writer per tenant (documented, warned at startup —
   the same posture as the webhooks dispatcher on plain KV).

Merkle trees and C2SP-format checkpoints are **not** in v1: a chain plus signed heads already gives
customers edit/delete/reorder/rewrite detection; Merkle proofs pay off when there are many
third-party verifiers needing logarithmic proofs, which is a later, additive change (new `v`).

## Consequences

- Tamper evidence is on by default and costs two SHA-256 passes per event plus one head read/write
  per batch.
- Tail truncation between checkpoints is detectable only against a checkpoint the tenant holds;
  frequent checkpoints + streaming them narrows the window.
- The format is versioned (`integrity.v`, checkpoint `v`) so it can evolve without breaking old
  bundles.
