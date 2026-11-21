# verify-export × @xtandard/audit

Export a **verifiable bundle** and check it offline — the way your customer's
auditor would: with nothing but the file and your published public keys.

A bundle is one JSONL file: a header, every retained event of the tenant (with
its hash-chain block), the signed checkpoints, and the JWKS. Verification
re-derives every hash, checks every link, and verifies the Ed25519 signatures.

## What's here

`src/index.ts`:

1. records two tenants with an Ed25519 signer and writes the public JWKS;
2. exports three bundles to `./.audit/`:
   - **`acme.jsonl`** — the head is signed right after the export notes itself,
     so every event (including its own `audit_log.exported`) is covered;
   - **`globex.jsonl`** — valid, but the newest events came after the last
     checkpoint: an **unsigned tail**;
   - **`tampered.jsonl`** — acme's bundle with one invoice amount edited
     (4900 → 49), hashes untouched;
3. verifies each with **`@xtandard/audit/verify`** (`verifyBundle`, zero
   dependencies, Web Crypto only);
4. runs **`xtandard-audit verify --bundle <file> --jwks jwks.json`** on each and
   prints the exit code.

| Exit | Meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | valid, anchored (genesis or a verified checkpoint), every event covered by a verified signature |
| `2`  | valid, but the tail (or everything) is unsigned — consistent, yet truncating it is undetectable |
| `1`  | invalid: tampered content, broken links, gaps or a bad signature                               |

## Run it

The CLI comes from the installed package, so build the repo root first
(`bun run build`), then:

```bash
bun install
bun run start
```

```txt
@xtandard/audit/verify:
  acme.jsonl      VALID   13 events, anchor genesis, signed through 13 of 13
  globex.jsonl    VALID   9 events, anchor genesis, signed through 5 of 9
  tampered.jsonl  INVALID 13 events, … — digest-mismatch at #3: …

$ xtandard-audit verify --bundle acme.jsonl --jwks jwks.json   → exit 0
$ xtandard-audit verify --bundle globex.jsonl --jwks jwks.json → exit 2
$ xtandard-audit verify --bundle tampered.jsonl --jwks jwks.json → exit 1
```

Without `--jwks` the CLI uses the keys embedded in the bundle (and says so);
passing the operator's published keys (`{basePath}/api/integrity/keys`) means
the file is not trusted for them. Details: [Integrity](../../docs/INTEGRITY.md).

## Files

- [`src/index.ts`](./src/index.ts) — record, sign, export, tamper, verify (library + CLI).
