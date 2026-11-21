# Integrity

How `@xtandard/audit` makes logs **tamper-evident** — and how you, your customers, and their auditors
check them ([ADR 0004](ADR/0004-tamper-evidence-hash-chain-checkpoints.md),
[ADR 0011](ADR/0011-erasure-vs-immutability.md)).

## The chain

Every tenant has its own hash chain. Each event carries:

```ts
integrity: {
  v: 1,
  prevHash: "sha256:…", // the previous event's hash (64 zeros for seq 1)
  hash: "sha256:…", // SHA-256 over the canonical header below
  digests: { actor, targets, context, metadata, description }, // salted per-section digests
  erased?: ["metadata"], // sections erased after the fact
}
```

```txt
digest(section) = "sha256:" + hex(SHA-256(id + "\n" + canonical(section)))
header          = { v, id, tenant, seq, action, occurredAt, recordedAt, outcome, prevHash, digests }
hash            = "sha256:" + hex(SHA-256(canonical(header)))
```

`canonical` is JSON with keys sorted at every depth and no whitespace (RFC 8785 for the shapes events
allow). Anyone can re-derive every hash in any language.

What it detects: an edited field (digest or hash mismatch), a deleted or inserted event (seq gap or link
mismatch), reordering, and events moved between tenants.

## Checkpoints

A checkpoint signs a chain head: `{ v, id, tenant, kind: "head" | "base", seq, hash, at, keyId, alg, signature }`.

```ts
import { createAuditCore, ed25519Signer, generateSigningKeyPair } from "@xtandard/audit";

const { privateJwk } = await generateSigningKeyPair(); // or: xtandard-audit keygen
const audit = createAuditCore({
  storage,
  signer: await ed25519Signer(privateJwk), // keep the private JWK in a secret manager
  checkpoints: { every: 1000, interval: "1h" }, // the default when a signer is set
});
```

- `ed25519Signer` (recommended): the public key is served as a JWKS at `GET {basePath}/api/integrity/keys`
  so customers verify signatures themselves. `hmacSigner(secret)` is the symmetric alternative for
  internal-only verification. Implement `AuditSigner` to sign with a KMS/HSM.
- Rotating keys: switch the signer and pass the old public keys as `verificationKeys`.
- **Stream checkpoints to your customers** (every stream does by default): a tenant holding signed heads can
  detect a later rewrite of anything before them — even by someone with database access and the signing
  key, since the old heads would no longer match.

## Verifying

```ts
const report = await audit.verify("acme"); // or { fromSeq, toSeq }
// { ok, checked, fromSeq, toSeq, anchor, signedThrough, checkpointsVerified, erased, issues }
```

- `anchor`: `genesis` (starts at seq 1), `checkpoint` (a verified checkpoint links to the first event — after
  retention, the `base` checkpoint), or `unanchored`.
- `signedThrough`: the highest seq covered by a verified signature; later events are consistent but not yet
  signed.
- `issues[].kind`: `digest-mismatch`, `hash-mismatch`, `link-mismatch`, `seq-gap`, `tenant-mismatch`,
  `bad-signature`, `unknown-key`, `checkpoint-mismatch`, `unjustified-erasure`, `malformed`.

### Offline, by the customer

Export the **bundle** (`GET /api/tenants/:t/export?format=bundle`, the portal's export menu, or
`xtandard-audit export --tenant acme --format bundle`): one JSONL file with a header, every retained event,
the checkpoints, and the JWKS. Verify it anywhere:

```sh
xtandard-audit verify --bundle acme.jsonl --jwks https://app.example.com/audit/api/integrity/keys
# exit 0 = valid and anchored · 2 = valid but the tail is not covered by a signature · 1 = invalid
```

```ts
import { verifyBundle, keysFromJwks } from "@xtandard/audit/verify"; // zero dependencies, Web Crypto

const report = await verifyBundle(text, { keys: await keysFromJwks(publishedJwks) });
```

Pass keys obtained independently (your published JWKS) rather than trusting the file's own.

## Erasure without breaking the chain

Because the chain commits to digests, personal data can be removed:

```ts
await audit.erase("acme", eventId, {
  sections: ["actor", "metadata"],
  reason: "GDPR request #123",
});
await audit.eraseActor("acme", "user_42", { reason: "account deleted" });
```

The sections' content is replaced (the actor keeps a pseudonymous `erased:<digest prefix>` id), the original
digests are kept, and an `audit_log.erased` event is chained. The verifier skips digest checks for erased
sections **only** when a chained `audit_log.erased` record justifies them — otherwise it reports
`unjustified-erasure`, so "erase" cannot be used to silently swap content. Digests are salted with the event
id so an erased low-entropy value (an email) cannot be confirmed by hashing guesses.

## Retention

Retention removes a **prefix** of a tenant's chain (`keepLast`, `maxAge`, per-tenant overrides) and writes a
signed `base` checkpoint anchoring the first retained event. Streams hold retention back until they have
delivered.

## Threat model

Tamper-**evident**, not tamper-proof. Someone with write access to the database can change rows; they cannot
make the change verify against signatures they do not hold, nor against signed heads your customers already
received. Someone with database access **and** the signing key can rewrite history that no customer has
checkpoints for yet — frequent checkpoints, streaming them out, and keeping the key in a KMS shrink that
window. Merkle-tree inclusion proofs and external anchoring (Rekor, OpenTimestamps) are possible later
additions behind the same versioned format.
