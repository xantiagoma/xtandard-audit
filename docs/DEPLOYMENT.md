# Deployment

The deployment shapes, the standalone image, the CLI, the full env contract, and the security posture you must read before going to production.

## Shapes

1. **Embedded** — `record()` and the panel inside your app (`auditPanel({ storage, streams })`). One process, nothing extra to operate: the panel runs the stream runner and the retention timer. With several app replicas, streams take a per-stream lease on compare-and-swap storage (redis, postgres, memory, …); on plain KV storage run streams in exactly one replica (`streamRunner: false` on the rest — they still show stream status).
2. **Split ingest** — the web tier only records (`createAuditCore({ storage })`, or `createRecorder` for buffered fire-and-forget, ADR 0002) and never mounts the panel; a separate `xtandard-audit serve` (or the image) over the **same storage** serves the panel/portal, runs the streams and prunes. Keeps SIEM egress and export load off your web tier. Recording never depends on the panel.
3. **Standalone** — the Docker image serves panel + API + streams; apps record over the HTTP API (`POST {BASE_PATH}/api/tenants/:tenant/events`, `event:record`).

Recording is synchronous-commit and per-tenant serialized inside one core; several processes appending to the same tenant are safe on drivers with a native event log or compare-and-swap (the chain head is claimed atomically and conflicts retry).

## Standalone / Docker

```sh
docker run -p 3000:3000 \
  -e STORAGE_DRIVER=postgres -e DATABASE_URL=postgres://… \
  -e AUTH_MODE=basic -e AUTH_USERNAME=ops -e AUTH_PASSWORD_HASH='<scrypt hash>' \
  -e AUDIT_SIGNING_KEY="$(xtandard-audit keygen | head -1)" \
  -e PORTAL_SECRET='<random string>' \
  -e RETENTION_MAX_AGE=365d \
  ghcr.io/xantiagoma/xtandard-audit
```

`/healthcheck` (also `{BASE_PATH}/healthcheck`) answers 200 for orchestrator probes. The image (`apps/standalone`) runs `xtandard-audit serve`; the only difference from the bare CLI is the storage default (`memory`, an ephemeral demo).

## CLI

`xtandard-audit` (the package `bin`; `npx @xtandard/audit …` / `bunx @xtandard/audit …`) operates on the same storage your app uses, configured by the env below.

| Command                                                                           | What it does                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `serve [--port n]`                                                                | panel + API + streams + retention timer (what the image runs)                   |
| `record --tenant t --action a --actor id [--targets type:id,…] [--metadata json]` | record one event from shell/CI (`--event '<json>'` for the full input)          |
| `query [--tenant t] [--actions a,b] … [--json]`                                   | search; flags are the HTTP query parameter names (`--actorId`, `--from`, …)     |
| `export --tenant t [--format csv\|json\|jsonl\|bundle] [--out f]`                 | stream an export (self-audited as an export by `cli`)                           |
| `verify --bundle f.jsonl [--jwks file\|url] [--hmac-secret s]`                    | verify an export bundle offline                                                 |
| `verify --tenant t [--fromSeq n] [--toSeq n]`                                     | verify a tenant's chain in storage                                              |
| `prune [--tenant t]`                                                              | apply `RETENTION_*` now (cron instead of the `serve` timer)                     |
| `checkpoint --tenant t`                                                           | sign the tenant's chain head                                                    |
| `keygen`                                                                          | print an Ed25519 private JWK (line 1 → `AUDIT_SIGNING_KEY`) and its public JWKS |
| `tenants`, `actions`                                                              | list tenants (head seq, retained count) / the action catalog                    |

`verify` exit codes, for CI and auditors: **0** = valid and anchored (genesis or a verified checkpoint) with every event covered by a verified checkpoint; **2** = valid, but the tail (or everything) is not covered by a verified signature — internally consistent, yet truncation of the tail would be undetectable; **1** = invalid (tampered, gaps, bad signature). Without `--jwks` the bundle's embedded keys are used (and a note says so); pass the operator's published keys (`{BASE_PATH}/api/integrity/keys`) to not trust the file for them.

Storage drivers and sinks are imported lazily from their subpaths, so the CLI only needs the peer of the driver you pick (`redis`, `pg`, `mongodb`, …); `sqlite` needs the Bun runtime (`bunx`).

## Environment variables (CLI `serve` and the image)

| Variable                                                                             | Meaning                                                                                                                                                                | Default                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `STORAGE_DRIVER`                                                                     | `memory` `file` `redis` `postgres` `mongodb` `sqlite` `libsql`                                                                                                         | `file` (image: `memory`)                          |
| `STORAGE_FILE_DIR`                                                                   | file driver directory                                                                                                                                                  | `./.audit`                                        |
| `REDIS_URL`, `STORAGE_PREFIX`                                                        | redis connection + key prefix                                                                                                                                          | `redis://localhost:6379`, `xtandard:audit`        |
| `DATABASE_URL` or `POSTGRES_URL`, `STORAGE_PG_TABLE`                                 | postgres                                                                                                                                                               | table `xtandard_audit`                            |
| `MONGO_URL`, `MONGO_DB`, `STORAGE_MONGO_COLLECTION`                                  | mongodb                                                                                                                                                                | db `xtandard_audit`, collection `audit`           |
| `STORAGE_SQLITE_PATH`, `LIBSQL_URL`/`LIBSQL_AUTH_TOKEN`                              | sqlite / libsql                                                                                                                                                        | `./.audit/audit.sqlite`, `file:./.audit/audit.db` |
| `AUDIT_SIGNING_KEY`                                                                  | Ed25519 private JWK (JSON) — signs checkpoints; public key at `/api/integrity/keys`                                                                                    | off (no checkpoints)                              |
| `AUDIT_HMAC_SECRET`                                                                  | HMAC checkpoint secret (only holders can verify), when no signing key                                                                                                  | off                                               |
| `RETENTION_MAX_AGE`, `RETENTION_KEEP_LAST`                                           | retention (kept if either rule keeps it; never past an undelivered stream cursor)                                                                                      | off                                               |
| `MAINTENANCE_INTERVAL`                                                               | how often `serve` prunes; `0`/`false` disables                                                                                                                         | `1h`                                              |
| `AUDIT_STREAMS`                                                                      | JSON array `[{ "name", "sink", "options", "tenants"?, "filter"?, "batchSize"?, "startFrom"?, "checkpoints"? }]`; `sink` names a `@xtandard/audit/sinks/<sink>` subpath | none                                              |
| `STREAM_RUNNER`                                                                      | `0`/`false`: show stream status, but run the streams elsewhere                                                                                                         | on                                                |
| `PORT`, `BASE_PATH`, `TITLE`, `LOGO_URL`                                             | HTTP + branding                                                                                                                                                        | `3000`, `/`, `@xtandard/audit`                    |
| `READONLY`                                                                           | mutations answer `423`                                                                                                                                                 | `false`                                           |
| `AUTH_MODE`, `AUTH_USERNAME`, `AUTH_PASSWORD_HASH` (or `AUTH_PASSWORD`), `AUTH_ROLE` | `none`/`basic`; the basic user's role (`admin` `auditor` `viewer`)                                                                                                     | `none`, role `admin`                              |
| `PORTAL_SECRET`                                                                      | enables portal tokens                                                                                                                                                  | off                                               |

```sh
# A SIEM stream over HTTP, delivering only new events:
AUDIT_STREAMS='[{"name":"siem","sink":"http","options":{"url":"https://siem.example/ingest"},"startFrom":"now"}]'
```

## Security posture — read this

- **The panel is an admin surface.** `auth: none` is a quickstart default, not a deployment. Use basic/delegated auth + roles, or keep the panel off the public internet and expose only the portal. Erasure (`event:erase`) and retention (`retention:prune`) are destructive: grant them to few principals (the default `auditor` role has neither).
- **Signing keys.** `AUDIT_SIGNING_KEY` is the trust anchor of every checkpoint: keep it in a secret manager, publish the public JWKS, and keep retired public keys available to verifiers (`verificationKeys` on the core) when you rotate. HMAC checkpoints can only be verified by holders of the secret — prefer Ed25519 when customers verify.
- **Tamper evidence is not tamper prevention.** A database admin can rewrite the log; what they cannot do is make it verify against checkpoints signed before the rewrite. Stream checkpoints to an independent store (a SIEM, an S3 bucket with object lock, the customer) so the anchors live outside the database.
- **Portal tokens are bearer credentials** — HTTPS only; short expiry (default `1h`); rotating `PORTAL_SECRET` is the revocation story ([Portal](./PORTAL.md)).
- **Client IPs.** `auditContext()` trusts proxy headers by default; set `trustProxy: false` when clients can reach the app directly ([Adapters](./ADAPTERS.md)).
- **Cloudflare Workers**: the KV adapter works, but there is no long-lived process — run `runner.tick()` and `core.prune()` from a cron trigger.

## Operational checklist

- [ ] Real storage driver + backups (the log is the product)
- [ ] `AUDIT_SIGNING_KEY` set, public JWKS published, checkpoints streamed somewhere independent
- [ ] Auth + authorization on the panel; `PORTAL_SECRET` set only if the portal is used
- [ ] Retention configured (`RETENTION_*`) to your compliance window — logs grow unboundedly otherwise
- [ ] Streams monitored (lag / last error in the panel, `onError` on the runner)
- [ ] One stream runner per plain-KV storage; any number over compare-and-swap storage
