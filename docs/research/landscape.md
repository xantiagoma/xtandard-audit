# Landscape: open-source audit-log control planes (research gate)

Date of research: 2026-11-20. "Recent" means activity on or after 2026-05-20 (about 6 months).

Method: `gh search repos` on the topics `audit-log`, `audit-logs`, `audit-trail`, `tamper-evident` and
`audit-logging`, plus keyword searches with `--created ">2025-11-20"`. Then `gh api repos/OWNER/REPO`
for stars, last push, open issues and archived flag; `gh api .../releases` and `.../commits` for the
last release and last commit; `gh api .../license` with the LICENSE text decoded and read (not just
GitHub's SPDX guess). npm registry search (`/-/v1/search`) for "audit log", "audit-log",
"audit trail", "activity log", "tamper-evident audit", "hash chain audit" and ORM-specific queries;
`npm view` for license, version and publish dates. Web search for products with no public repository.
Retraced and retraced-js were cloned and grepped for their hashing code.

"unknown" means I could not verify it. Star and issue counts are as of 2026-11-20.

What we are comparing against: an **embeddable, self-hosted, MIT library** for B2B SaaS. You record
typed events (actor, action, targets, tenant, context), store them in pluggable storage, query them
with filters and keyset pagination, and get tamper evidence from a hash chain plus signed
checkpoints. It also ships an embeddable React viewer per tenant, an admin UI, streaming and export
to SIEMs, and framework adapters.

---

## 1. Direct competitors (tenant-facing audit-log products)

### Retraced (retracedhq/retraced)

- Repo: https://github.com/retracedhq/retraced. LICENSE file: **Apache-2.0** (read:
  https://github.com/retracedhq/retraced/blob/main/LICENSE). Its `package.json` says
  `"license": "UNLICENSED"`, an internal inconsistency; the LICENSE file governs.
- Activity: 450★, 32 open issues. Last GitHub release **v1.13.1 on 2024-11-06**. The default branch
  `main` was last committed 2025-08-26 (a README edit). Real maintenance happens on the **`v1.4`
  branch**: last commit 2026-08-06 (PR #1911, "Fix Invalid date … in audit log GraphQL API"), plus
  #1908 on 2026-06-01 and #1906 on 2026-04-06. PR #1910's title mentions the "vendor portal", which
  suggests a single downstream product is driving the fixes. Treat it as low-activity, fix-only
  maintenance.
- Clients: `@retracedhq/retraced` (retraced-js, Apache-2.0) was last published to npm 2025-04-26 at
  v0.7.23. `@retracedhq/logs-viewer` (Apache-2.0, React ≥18.2 peer) was last published 2025-03-29
  at v2.10.1; that repo was last pushed 2025-12-15. There is also a Go client, retraced-go.
- **Shape: standalone service.** A Node/TS API (`pg`, `@elastic/elasticsearch`, `nsqjs`) needs
  Postgres plus Elasticsearch or OpenSearch plus NSQ, and is deployed with Helm, kustomize or
  docker-compose. Apps talk to it over HTTP (publisher API, GraphQL, enterprise API). The React viewer
  is a separate package that talks to the service. It is not a library you embed in your app process.
- Features (from `src/handlers`, `src/models`): a project → group (tenant) → event model with `crud`,
  `actor`, `target`, `source_ip`, `is_failure`, `is_anonymous` and `fields`; **viewer descriptors and
  viewer sessions** (scoped tokens for the embedded per-tenant viewer); **saved exports rendered to
  CSV**; **enterprise tokens**, so a customer's tenant can pull its own events over the API (a pull
  form of SIEM integration); a GraphQL search; display templates; and an admin portal with magic-link
  login. Feature branches (`feature/vector`, `feature/vector-s3`, `feature/iceberg`) show streaming
  work that was started but not released.
- Tamper evidence: see §7. It is a per-event SHA-256 over a canonical string, with no chain or
  checkpoints.
- Why not sufficient: wrong shape (an operated service with ES and NSQ), barely maintained (no
  release in about two years), and no hash chain or signed checkpoints.

### BoxyHQ: what it ships now

- **Ory acquired BoxyHQ on 2025-05-29.** BoxyHQ's SSO product "SAML Jackson" is now **Ory Polis**:
  `boxyhq/jackson` redirects to https://github.com/ory/polis (Apache-2.0, 2,268★, last release
  v26.2.0 on 2026-03-20, last push 2026-07-27). Polis is SSO and directory sync; it has no audit-log
  module. Sources: https://archive.ory.sh/t/28865287/loudspeaker-ory-acquires-boxyhq-some-of-you-might-know-boxyh,
  https://www.ory.com/blog/category/ory-polis
- `boxyhq/hermes` ("Audit logs service", Apache-2.0) is **archived**; last push 2022-07-19.
- `boxyhq/saas-starter-kit` (Apache-2.0, 4,971★, last commit 2026-05-08, last release v1.6.0 on
  2024-12-24) integrates Retraced as its audit-log component. It is a starter app, not a library.
- The "BoxyHQ audit module" is therefore Retraced, covered above. I found no Ory announcement about
  Retraced's future, so its status under Ory is **unknown**.

### AuditKit (auditkit.dev)

What I found, exactly:

- **Source repo: https://github.com/AuditKitDev/auditkit** (homepage set to auditkit.dev). Created
  2026-03-09; 3★, 0 forks, 0 open issues; 26 commits, **all by one contributor**. Releases/tags v1.0.0
  through **v1.3.0 (2026-05-14)**. Last push 2026-10-06 ("README for the v2 tree").
- **LICENSE file: GNU AGPL-3.0**, with an added clause saying that **`/ee` is proprietary and needs a
  commercial license**. Every package in the current tree declares `"license": "AGPL-3.0-only"`.
  auditkit.dev/llms-full.txt says: "Licensed under AGPLv3 with a commercial license option for
  enterprises."
- Current `main` (the "v2 tree", packages at `2.0.0-alpha.0`): `@auditkit/core` (RFC 8785 JCS
  canonicalization, per-tenant hash chain, RFC 6962 Merkle trees, export format), `@auditkit/server`
  (REST `/v1`, dashboard API, MCP server, **SQLite storage, one file per project**), `anchor-rekor` and
  `anchor-ots` (publish Merkle roots to Sigstore Rekor and OpenTimestamps), `@auditkit/verify` (an
  offline `auditkit-verify export.jsonl` CLI), a TS SDK, a Python SDK, and `web` (Astro, private).
- **There is no React viewer in the current tree.** The v1.3.0 tag had `packages/react`
  (`@auditkit/react` 0.1.0, AGPL-3.0-or-later), `packages/next`, `packages/hono`, `packages/drizzle`, Go
  and Java SDKs, a Terraform provider and an `ee/` directory. These were removed in v2.
- **npm:** `@auditkit/sdk`, `@auditkit/react`, `@auditkit/viewer`, `@auditkit/core` and
  `@auditkit/verify` all return **E404 (not published)**. The unscoped `auditkit` package on npm
  (MIT, 0.1.8) is an **unrelated** "website audits" CLI by a different author. The site's docs refer
  to `@auditkit/react`, `@auditkit/viewer` and `@auditkit/sdk` inconsistently.
- Commercial: auditkit.dev lists hosted plans (for example, Business at $499/mo and a $999/mo tier).
- Shape: a hosted SaaS plus a self-hostable service; SDKs call the API. Not an embeddable library.
- Why not sufficient: AGPL plus proprietary `ee`, a single maintainer, 3★, no published packages,
  and the React viewer was removed. Its tamper-evidence design is a good reference (see §7).

### WorkOS Audit Logs (paid SaaS)

- https://workos.com/docs/audit-logs. The SDKs are MIT (for example `workos/workos-node`, with
  `@workos-inc/node` 12.4.0 published 2026-11-19), but the service is proprietary and hosted.
- Event: `action`, `occurred_at`, `actor {type,id,name?,metadata?}`, `targets[]`,
  `context {location,user_agent}`, `metadata`, `version`, scoped to an **Organization** (the tenant),
  with an **Idempotency-Key**.
- **Schema per action:** you must declare allowed events in the dashboard (an action name plus target
  types), with an optional **JSON Schema for metadata** and **versioned schemas**.
- **Export:** CSV per organization with a date range of up to 31 days; the download URL expires.
- **Retention:** per organization, 30 days by default, configurable from 1 month to 10 years (it can
  be increased but not reduced).
- **Log Streams:** customers configure streaming to Datadog, Splunk, S3, GCS, Snowflake, Azure
  Monitor, or a generic HTTP POST endpoint (https://workos.com/docs/audit-logs/log-streams). Streams
  have Active, Inactive, Error and Invalid states.
- **Admin Portal:** generate a link with the `audit_logs` intent and the customer views and exports
  its own events. Platform Audit Logs adds WorkOS's own events to the same trail.
- Tamper evidence: the docs pages I read (audit-logs.md, audit-logs product page, log-streams.md)
  document **no cryptographic tamper evidence** (no hash, signature or proof API). Unknown beyond that.
- Pricing: third-party sources cite $125/mo per SIEM stream and $99/mo per million stored events;
  not confirmed on workos.com/pricing (the page did not render in search results).

### Pangea Secure Audit Log (SaaS)

- Hosted API (https://pangea.cloud/docs/api/audit). The SDKs are MIT, for example
  `pangeacyber/pangea-javascript` (MIT, last push 2026-10-27; `pangea-node-sdk` 5.6.0 published
  2025-09-30). There is a **MIT React viewer**, `@pangeacyber/react-mui-audit-log-viewer`
  (2.0.4-beta.5, 2025-09-17), but it only talks to Pangea's API.
- **CrowdStrike announced an agreement to acquire Pangea on 2025-09-16**
  (https://www.crowdstrike.com/en-us/blog/crowdstrike-to-acquire-pangea/). The current status of the
  audit-log service is **unknown**.
- Tamper evidence (the most complete in the market): see §7. It uses Merkle trees with roots
  published to Arweave, plus membership and consistency proofs and signatures.
- Why not sufficient: SaaS, not self-hostable, and its future is uncertain after the acquisition.

### Auditum (auditumio/auditum)

- Apache-2.0 (LICENSE read via the API), 81★, 36 open issues. Last release **v0.3.0 on 2024-07-15**;
  the last commit, on 2025-10-26, is a dependabot merge. Go service over HTTP and gRPC: "Audit Log
  management system for any application."
- Shape: a standalone service. It has no tenant-facing viewer, no tamper evidence I could find, and
  it is effectively dormant.

### Other hosted "activity log" products with open SDKs (2026 newcomers)

- **Watchtower activity** (`@watchtowerobservability/activity`, `activity-web`, plus React Native,
  Vue, Svelte and Angular variants). The packages are Apache-2.0 and first published 2026-11-03; the
  repos have 0★. The npm description reads "**hosted** activity log: server SDK (record events, mint
  viewer sessions, list, export)" and offers a `<wt-activity>` web component. These are SDKs for a
  hosted service.
- **audkit** (npm `audkit`, MIT, 0.5.0, created 2026-06-18). Its README describes an RFC 6962 Merkle
  tree with Ed25519-signed roots published hourly, but the flow is "Create a project at audkit.dev …
  mint a scoped API key". It is a client for a hosted service. Its GitHub repo
  (TheUntraceable/audkit) returns 404.
- **sealtrail** (npm, MIT SDK for "the SealTrail cryptographic audit trail API"): hosted.

## 2. Svix-shaped peers (an open-source service plus a hosted cloud)

These show the shape we are _not_ building: an OSS server you operate, with a commercial cloud.

- **Svix** (svix/svix-webhooks): MIT, 3,488★, pushed 2026-11-21. A webhooks service in Rust; SDKs
  call the server.
- **Hookdeck Outpost** (hookdeck/outpost): Apache-2.0, 1,086★, pushed 2026-11-20. Outbound webhooks
  and event-destinations infrastructure. Its destination model (webhook, queue, Kinesis and similar)
  is relevant to SIEM streaming design.
- **Convoy** (frain-dev/convoy): 2,890★. The LICENSE is a **custom proprietary license agreement**
  ("BEFORE DOWNLOADING OR USING CONVOY … BINDING AGREEMENT"), not OSI.
- In audit logs, Retraced is the only established project with this shape, and it is barely
  maintained.

## 3. Transparency logs and verifiable databases (tamper-evidence building blocks)

| Project                         | License (file read)                                                                                                                                | Activity                                                                                                                | Shape                                                 | Relevance                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| google/trillian                 | Apache-2.0                                                                                                                                         | 3,765★, release v1.8.0 on 2026-09-21, pushed 2026-11-18                                                                 | Go gRPC service with MySQL/Spanner                    | README: "**Trillian is in maintenance mode** … We recommend that any new log operators first try Tessera." |
| transparency-dev/tessera        | Apache-2.0                                                                                                                                         | 262★, v1.0.4 on 2026-07-16, pushed 2026-11-19                                                                           | **Go library** for tile-based tlogs (C2SP tlog-tiles) | The design reference: RFC 6962 tree, checkpoints as C2SP signed notes, witnesses                           |
| transparency-dev/witness        | Apache-2.0                                                                                                                                         | 40★, pushed 2026-11-16                                                                                                  | Go                                                    | Witness cosigning (C2SP tlog-cosignature)                                                                  |
| sigstore/rekor                  | Apache-2.0                                                                                                                                         | 1,237★, v1.6.3 on 2026-11-20                                                                                            | Service on Trillian                                   | Public log that AuditKit anchors to                                                                        |
| sigstore/rekor-tiles (Rekor v2) | Apache-2.0                                                                                                                                         | 54★, v2.4.2 on 2026-11-10                                                                                               | Service on Tessera (GCP, AWS, POSIX)                  | Shows the move from Trillian to tiles                                                                      |
| codenotary/immudb               | **BSL 1.1** (LICENSE read: "Licensed Work: immudb Version 1.9DOM.2 or later", with a use grant excluding competitive hosted or embedded offerings) | 9,054★, v1.11.2 on 2026-09-03                                                                                           | Go database server, also embeddable in Go             | Not permissive; Merkle-backed verified reads are a useful design reference                                 |
| scalar-labs/scalardl            | Apache-2.0                                                                                                                                         | 118★, v3.14.2 on 2026-11-12                                                                                             | Java middleware                                       | Byzantine-fault detection over a DB; heavy                                                                 |
| BBVA/qed                        | Apache-2.0                                                                                                                                         | 105★, last push 2020-02-27                                                                                              | Go                                                    | Dead                                                                                                       |
| Amazon QLDB                     | proprietary                                                                                                                                        | **End of support 2025-07-31** (https://www.infoq.com/news/2024/07/aws-kill-qldb); AWS points users to Aurora PostgreSQL | AWS service                                           | Gone; QLDB's demise is a selling point for in-DB hash chains                                               |

## 4. Database-level auditing (Postgres)

| Project                                    | License (file read)                 | Activity                           | Shape                                                     | Why not sufficient                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------- | ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pgaudit/pgaudit                            | PostgreSQL License                  | 1,731★, release 19.0 on 2026-11-17 | PG extension; writes to the server log                    | Session/statement logging for DBAs; no actor or tenant semantics, no viewer                                                                                                   |
| supabase/supa_audit                        | Apache-2.0                          | **archived**, last push 2024-01-03 | PL/pgSQL triggers                                         | Archived; row-diff only                                                                                                                                                       |
| 2ndQuadrant/audit-trigger                  | PostgreSQL License (COPYRIGHT file) | last push 2023-09-04               | SQL trigger example                                       | Unmaintained; row-diff only                                                                                                                                                   |
| nearform/temporal_tables                   | MIT                                 | v1.2.1 on 2025-09-09               | PL/pgSQL system-versioning                                | History tables, not an audit log                                                                                                                                              |
| arkhipov/temporal_tables                   | BSD-2-Clause                        | pushed 2026-01-12                  | C extension                                               | Same                                                                                                                                                                          |
| pgMemento/pgMemento                        | LGPL-3.0                            | pushed 2026-04-27                  | PL/pgSQL                                                  | Copyleft-ish; schema-versioned row history                                                                                                                                    |
| Bemi (pgstack-io/bemi-io, formerly BemiHQ) | **SSPL v1** (LICENSE read)          | 400★, last commit 2025-12-23       | CDC worker (Debezium-style WAL) plus ORM context adapters | SSPL; WAL-based data-change tracking, not business audit events. Adapters `@bemi-db/prisma`, `@bemi-db/typeorm`, `@bemi-db/mikro-orm` and `@bemi-io/drizzle` are **LGPL-3.0** |
| varunchopra/postkit                        | Apache-2.0                          | 13★, pushed 2026-08-12             | SQL install bundle (includes audit)                       | Tiny; Postgres-only                                                                                                                                                           |

## 5. ORM and framework plugins (record-change history inside one app)

All of these are "who changed which row" model auditing for one framework. None has a tenant-facing
viewer, SIEM streaming, a typed action catalog, or tamper evidence, except where noted.

| Project                                                                                             | License                                                                        | Activity                                             | Notes                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| paper-trail-gem/paper_trail (Ruby)                                                                  | MIT                                                                            | 7,028★, last commit 2026-09-25                       | Rails model versioning                                                                                                                                                              |
| collectiveidea/audited (Ruby)                                                                       | MIT                                                                            | 3,496★, last commit 2025-11-18, 209 open issues      | Rails ORM extension; slowing                                                                                                                                                        |
| django-commons/django-auditlog (Python; formerly jazzband)                                          | MIT                                                                            | 1,391★, v3.4.2 on 2026-11-08                         | Django model change log                                                                                                                                                             |
| soynatan/django-easy-audit                                                                          | GPL-3.0                                                                        | 846★                                                 | Copyleft                                                                                                                                                                            |
| owen-it/laravel-auditing (PHP)                                                                      | MIT                                                                            | 3,474★, v14.0.7 on 2026-11-02                        | Eloquent auditing                                                                                                                                                                   |
| spatie/laravel-activitylog (PHP)                                                                    | MIT                                                                            | 5,917★, 5.1.5 on 2026-11-13                          | Activity log; closest in _API feel_ (`activity()->causedBy()->performedOn()->log()`)                                                                                                |
| laravel-chronicle/core (PHP)                                                                        | MIT                                                                            | 128★, 1.17.0 on 2026-11-02                           | **Hash chain plus signed checkpoints (Ed25519 or ECDSA P-256)**, append-only ledger, verification command. The closest _design_ match, but Laravel-only and without a tenant viewer |
| DamienHarper/auditor and auditor-bundle (PHP/Doctrine)                                              | MIT                                                                            | 202★ and 478★, active                                | Doctrine entity auditing                                                                                                                                                            |
| rcsofttech85/AuditTrailBundle (Symfony)                                                             | MIT                                                                            | 123★, pushed 2026-08-27                              | Symfony                                                                                                                                                                             |
| thepirat000/Audit.NET (.NET)                                                                        | MIT                                                                            | 2,663★, last commit 2026-09-16                       | Extensible .NET audit framework with many sinks; the most "pluggable storage"-like, but .NET and no tenant UI                                                                       |
| skoruba/AuditLogging (.NET)                                                                         | MIT                                                                            | 121★                                                 | EF Core                                                                                                                                                                             |
| izelnakri/paper_trail (Elixir/Ecto)                                                                 | MIT                                                                            | 601★, pushed 2026-01-21                              | Ecto versioning                                                                                                                                                                     |
| cap-js/audit-logging (SAP CAP)                                                                      | Apache-2.0                                                                     | 15★, npm `@cap-js/audit-logging` 1.3.0 on 2026-09-10 | SAP-specific                                                                                                                                                                        |
| sourcefuse/loopback4-audit-log (`@sourceloop/audit-log`)                                            | MIT (repo)                                                                     | 36★, pushed 2026-11-20                               | LoopBack 4 only                                                                                                                                                                     |
| Prisma: `@explita/prisma-audit-log`                                                                 | npm says MIT; the GitHub repo explita/prisma-audit-log has **no LICENSE file** | 12★, 0.3.0 on 2026-11-14                             | Client extension; row diffs                                                                                                                                                         |
| Prisma: `@generazioneai/prisma-audit`                                                               | MIT                                                                            | 0.2.0 on 2026-07-10                                  | Client extension                                                                                                                                                                    |
| Drizzle: `drizzle-audit` (xantiagoma/drizzle-audit, the user's own)                                 | MIT                                                                            | 1★, 0.1.13 on 2026-06-27                             | Configurable Drizzle audit logging; reusable as a `@xtandard/audit` adapter                                                                                                         |
| TypeORM: kibae/typeorm-auditing                                                                     | MIT                                                                            | 32★, **last push 2023-01-14**                        | History tables; stale. The fork `@n4it/typeorm-audit` is GPL-3.0                                                                                                                    |
| MikroORM: vitkuv/mikro-orm-audit, StrikeForceZero/mikro-orm-audit-log                               | MIT or none                                                                    | 0–1★                                                 | Toy-sized                                                                                                                                                                           |
| Better Auth: `@checodo/better-auth-audit-log`                                                       | MIT                                                                            | 0.3.1 on 2026-11-18                                  | Auth events only                                                                                                                                                                    |
| `@ddd-ts-kit/audit`                                                                                 | MIT                                                                            | 0.114.1 on 2026-11-19; ddd-ts-kit 24★                | Hash-chained append-only audit inside a DDD kit (Drizzle, Knex or TypeORM peers); not standalone and no viewer                                                                      |
| `@better-forge/audit`                                                                               | MIT                                                                            | 0.2.0 on 2026-11-02; repo 0★                         | Fastify plus Drizzle module inside a starter kit                                                                                                                                    |
| `@molecule/api-audit`                                                                               | Apache-2.0                                                                     | 1.0.5 on 2026-10-26                                  | Interface inside the molecule.dev framework                                                                                                                                         |
| `@setu-ts/audit-plugin`                                                                             | MIT                                                                            | 0.13.0 on 2026-10-12                                 | Plugin inside the setu-ts framework                                                                                                                                                 |
| `@stackbilt/audit-chain`                                                                            | Apache-2.0                                                                     | 0.1.3; repo 0★, pushed 2026-08-23                    | SHA-256 chain on Cloudflare R2 plus D1 only                                                                                                                                         |
| `@crewhaus/audit-log`, `@lp-labs/audit-ledger`, `@agentlaw/audit`, `@nodii/audit-chain` and similar | MIT or Apache-2.0                                                              | 2026, very low usage                                 | Hash-chained JSONL or records for AI-agent tooling; single-purpose                                                                                                                  |
| tomaslachmann/open-audit ("OpenAudit", npm `@arcari/open-audit`)                                    | npm MIT; **no LICENSE file in the repo**                                       | 3★, last commit 2025-07-10                           | Node auditing with Postgres, Mongo and file adapters; dormant                                                                                                                       |
| `@nearform/trail-core` (nearform/trail)                                                             | MIT                                                                            | **archived**, last push 2022-06-17                   | Postgres audit-trail service; dead                                                                                                                                                  |
| `audit-log` (npm)                                                                                   | none declared                                                                  | last publish 2013                                    | Dead                                                                                                                                                                                |
| Go: AyoubTadlaoui/GoLogX                                                                            | MIT                                                                            | 8★, pushed 2026-06-10                                | Hash-chained, optionally Ed25519-signed log library; tiny                                                                                                                           |
| Go: shubhodeep9/witness                                                                             | MIT                                                                            | 4★, created 2026                                     | Field-level audit (GORM, Bun, Ent), django-auditlog style                                                                                                                           |
| Go: elastic/go-libaudit                                                                             | Apache-2.0                                                                     | 161★                                                 | Linux kernel audit, not related                                                                                                                                                     |
| Rust                                                                                                | —                                                                              | —                                                    | No maintained app-level audit-log library found; results were Linux-audit tools (laurel, GPL-3.0) or dead projects (kpcyrd/tr1pd, AGPL, 2018)                                       |

## 6. Adjacent products that have "audit" but are not audit-log libraries

- **Hoop** (hoophq/hoop): MIT (LICENSE read), 863★, release 1.315.0 on 2026-11-19. An access gateway
  for databases and servers with session recording and masking. It audits _infrastructure access_,
  not app events.
- **Tracecat** (TracecatHQ/tracecat): **AGPL-3.0**, 3,908★. A SOAR / security automation platform
  that _consumes_ audit logs. It is a potential SIEM-side consumer, not a competitor.
- **Cerbos** (cerbos/cerbos): Apache-2.0, 4,665★. `internal/audit` writes _authorization decision_
  logs to file, Kafka, local Badger or the Cerbos Hub backends. Internal to Cerbos and not reusable.
- **Permit.io / OPAL** (permitio/opal): Apache-2.0. OPAL distributes policy and data. Permit's audit
  logs are a feature of its hosted product; I did not find an OSS audit-log component (unknown).
- **Infisical** (Infisical/infisical): MIT _except `ee/`_ (LICENSE read). Its audit-log and
  audit-log-stream services live under `backend/src/ee/services/` (`audit-log`, `audit-log-stream`,
  `audit-log-stream-outbox`), so they are **not MIT**. It shows the "stream to SIEM via outbox"
  pattern.
- **Highlight** (highlight/highlight): Apache-2.0 except `highlight.io/` and `enterprise/` dirs.
  Observability, not relevant.
- **OpenObserve**: AGPL-3.0, 23,130★. An observability store and a plausible SIEM-like streaming
  destination, not a competitor.
- **ZizkaDB** (AGPL-3.0), Tracekit (MIT) and the many 2026 "tamper-evident audit trail for AI
  agents" repos: agent-governance tooling, not B2B tenant audit logs.

---

## 7. Tamper-evidence designs

**Retraced (verified in source).** `src/models/event/canonicalize.ts` builds a canonical string:
`id:action:target.id:actor.id:group.id:source_ip:is_failure:is_anonymous:` followed by sorted
`key=value;` pairs of `fields`, URL-escaped. It takes its **SHA-256**, and the publisher API returns
that hash on ingest. Clients recompute it with `Retraced.verifyHash(event, newEvent)` in retraced-js
(`src/event.ts`) to check the server stored what was sent. That is **per-event integrity only**:
there is no link between events, so deletion, reordering or truncation is undetectable, and there are
no signatures or checkpoints.

**WorkOS.** The docs pages I read document no cryptographic tamper evidence. Its integrity rests on
trust in a hosted, append-only service.

**Pangea Secure Audit Log** (https://pangea.cloud/docs/audit/about-tamperproofing,
https://pangea.cloud/blog/a-tamperproof-logging-implementation/):

- Events are leaves of a **Merkle tree**. A new **root hash plus a consistency proof** is published
  to a public ledger (**Arweave**) **every hour or every 10,000 events**, whichever comes first.
  Each published record holds the timestamp, root hash, tree size and consistency proof.
- `/search` and `/results` optionally return each event's hash, a **membership (inclusion) proof**
  and the root. Clients verify (1) the membership proof, (2) the consistency proof against the
  previously published root, and (3) an optional **event signature** (client-side signing with a
  vault key).

**Trillian, Tessera and Rekor (C2SP specs):**

- An **RFC 6962 Merkle tree** with domain-separated hashes: leaf `H(0x00‖data)`, node
  `H(0x01‖l‖r)`. It supports O(log n) **inclusion proofs** and **consistency proofs** between any
  two tree sizes, which detect any rewrite of history, not just edits.
- **Checkpoints** (C2SP `tlog-checkpoint`) are three lines: origin, tree size and base64 root hash,
  signed as a **C2SP signed note** (Ed25519). **Witnesses** co-sign checkpoints (C2SP
  `tlog-cosignature`) after checking consistency with the last one they saw, which defeats
  split-view attacks. Clients can require a quorum of witness cosignatures.
- **Tessera** stores the tree as static **tiles** (C2SP `tlog-tiles`), so verification needs only
  static-file reads. Trillian itself is in maintenance mode in favor of Tessera, and Rekor v2 is
  built on Tessera.

**AuditKit** (README, verified): RFC 8785 JCS canonicalization, then a **per-tenant hash chain**,
then events are **signed**, then **batched into RFC 6962 Merkle trees** whose roots are **anchored
to Sigstore Rekor and OpenTimestamps**. Exports are JSONL; `auditkit-verify export.jsonl` exits
VALID/0, VALID_UNANCHORED/2 or INVALID/1 offline.

**laravel-chronicle** (README): canonicalized payload, then a payload hash and a **chain hash
linking to the previous entry**, then **signed checkpoints** (Ed25519 via sodium, or ECDSA P-256),
with optional external anchoring and KMS signing.

**immudb:** a Merkle-backed key-value and SQL store with client-side verified reads (BSL, design
reference only).

### Concrete takeaways for @xtandard/audit

1. **Canonical bytes first.** Hash **RFC 8785 (JCS) canonical JSON** of the stored event, all fields
   except the hash fields themselves, so any language can re-derive it. Retraced's ad-hoc
   colon-string covers only a few fields; avoid that.
2. **Per-tenant hash chain:** `hash_n = SHA-256(prev_hash_n ‖ canonical(event_n))`, with a
   per-tenant `seq` (gapless, monotonic) and `prev_hash`. Chaining per tenant keeps verification and
   export independent per customer and avoids a global write bottleneck. Assigning `seq` and
   `prev_hash` must be serialized per tenant: a row lock or advisory lock in SQL, or a single writer.
3. **Periodic signed checkpoints:** `{tenant, seq, head_hash, timestamp}` written in the C2SP
   signed-note format (`origin\nsize\nroot\n` plus an Ed25519 signature line). Run them on a timer
   or every N events, like Pangea's 1 h / 10k. Keep the signing key outside the database (KMS or
   env), with a pluggable `Signer` interface.
4. **Optional Merkle layer later.** A hash chain verifies in O(n) and can't give compact inclusion
   proofs. If customers need to verify a single event, add RFC 6962 trees per checkpoint window and
   sign the tree root instead of the chain head. Design the checkpoint format so this is additive.
5. **Optional external anchoring:** a pluggable `Anchor` that publishes checkpoints to an outside
   witness (Rekor v2, OpenTimestamps, or the customer's SIEM / S3 object lock). An operator with DB
   access can rewrite the chain and re-sign; only external anchors or witnesses stop that.
6. **Verification CLI and library:** `audit verify --tenant acme export.jsonl --pubkey …` recomputes
   hashes, checks `seq` continuity and checkpoint signatures, and returns distinct exit codes (AuditKit
   uses 0 valid, 2 valid-but-unanchored, 1 invalid). Ship the same verifier as a pure function so
   the React viewer can show a "verified up to checkpoint N" badge.
7. **Exports carry proofs:** JSONL plus the covering checkpoints, so a customer or auditor can verify
   offline without trusting us.
8. **Be honest about the threat model:** tamper-_evident_, not tamper-_proof_. Document what a DB
   admin can and cannot do undetected, with and without external anchoring.

## 8. Feature checklist from the market

| Feature                                                            | WorkOS                                                                                                  | Retraced                                                                           | Pangea                                                      | AuditKit                                   | Notes for us                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Event model actor / action / targets / tenant / context            | ✓ (`targets[]`, `context.location/user_agent`, `metadata`, Organization)                                | ✓ (single `target`, `group` = tenant, `crud`, `fields`, `source_ip`, `is_failure`) | ✓ (actor, action, target, status, source, old/new, message) | ✓ (tenant, actor, action, target, payload) | Use a WorkOS-like shape: multiple targets plus typed metadata                                                              |
| **Schema per action** (declared catalog, typed metadata, versions) | ✓ dashboard catalog, JSON Schema metadata, schema versions                                              | display templates only                                                             | config-defined schema                                       | unknown                                    | A typed action registry in TS (Standard Schema / zod), with versioning                                                     |
| Idempotency                                                        | ✓ Idempotency-Key                                                                                       | unknown                                                                            | unknown                                                     | unknown                                    | Idempotency key per tenant                                                                                                 |
| Query, filter, paginate                                            | ✓ (API, Admin Portal)                                                                                   | ✓ GraphQL plus search, keyset on `canonical_time,id`                               | ✓ search with proofs                                        | ✓                                          | Keyset pagination (already planned)                                                                                        |
| **CSV export**                                                     | ✓ per org, ≤31-day range, expiring URL                                                                  | ✓ saved exports rendered as CSV                                                    | unknown                                                     | ✓ JSONL export                             | CSV plus JSONL with proofs                                                                                                 |
| **SIEM streaming**                                                 | ✓ Log Streams: Datadog, Splunk, S3, GCS, Snowflake, Azure Monitor, HTTP POST, with status state machine | ✗ released (pull via enterprise tokens; Vector branches unreleased)                | unknown                                                     | ✗                                          | Pluggable sinks with an outbox, per-tenant config and a status machine (Infisical uses an outbox too)                      |
| Customer-pull API                                                  | via Admin Portal / API                                                                                  | ✓ enterprise tokens                                                                | ✓                                                           | ✓ API keys                                 | Per-tenant read tokens                                                                                                     |
| **Retention**                                                      | ✓ per org, 30 d default, 1 mo–10 y, increase-only                                                       | unknown                                                                            | ✓ (plan-based)                                              | ✓ plan-based (3 y / 7 y tiers)             | Per-tenant retention; must interact correctly with the hash chain (prune whole checkpoint windows, keep the boundary hash) |
| **Embeddable per-tenant viewer**                                   | ✓ hosted Admin Portal (link with `audit_logs` intent)                                                   | ✓ `@retracedhq/logs-viewer` React plus viewer tokens                               | ✓ MIT React MUI viewer bound to Pangea                      | removed in v2                              | React viewer with scoped viewer tokens, headless hooks, theming                                                            |
| Admin / internal UI                                                | ✓ WorkOS dashboard                                                                                      | ✓ admin portal                                                                     | ✓ console                                                   | ✓ dashboard                                | Admin UI (cross-tenant)                                                                                                    |
| Tamper evidence                                                    | not documented                                                                                          | per-event hash only                                                                | Merkle tree, Arweave roots, proofs                          | chain, Merkle, Rekor/OTS anchors           | Chain plus signed checkpoints plus a verify CLI; Merkle and anchors are pluggable                                          |
| Platform / system events                                           | ✓ Platform Audit Logs                                                                                   | —                                                                                  | —                                                           | —                                          | Internal events (exports, retention changes, viewer access) logged into the same tenant trail                              |
| Self-hosted                                                        | ✗                                                                                                       | ✓ (heavy: PG, ES, NSQ)                                                             | ✗                                                           | ✓ (SQLite service)                         | ✓ as an in-process library over the user's own DB                                                                          |

---

## 9. Summary table

| Name                                                                                       | License (verified)                                          | Last activity                                                                  | Shape                                                             | Embeddable lib?            | Why not sufficient                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Retraced                                                                                   | Apache-2.0                                                  | commit 2026-08-06 (v1.4 branch); last release 2024-11-06; npm clients Apr 2025 | Standalone service (PG, ES/OpenSearch, NSQ) plus React viewer pkg | ✗                          | Service shape, fix-only maintenance, per-event hash only, no streaming released               |
| BoxyHQ → Ory (Polis; hermes)                                                               | Apache-2.0                                                  | Polis 2026-07-27; hermes archived 2022                                         | SSO service; archived audit service                               | ✗                          | No audit product left besides Retraced                                                        |
| AuditKit (AuditKitDev/auditkit)                                                            | **AGPL-3.0** plus proprietary `ee/`                         | 2026-10-06; release v1.3.0 2026-05-14                                          | SaaS plus self-hostable service (SQLite)                          | ✗                          | Copyleft, single maintainer, 3★, packages not on npm, React viewer removed                    |
| WorkOS Audit Logs                                                                          | Proprietary SaaS (MIT SDKs)                                 | SDK 2026-11-19                                                                 | SaaS                                                              | ✗                          | Paid, hosted, no documented crypto tamper evidence                                            |
| Pangea Secure Audit Log                                                                    | Proprietary SaaS (MIT SDKs and viewer)                      | SDK repo 2026-10-27                                                            | SaaS                                                              | ✗                          | Hosted only; acquisition by CrowdStrike makes its future unknown                              |
| Auditum                                                                                    | Apache-2.0                                                  | release 2024-07-15; commit 2025-10-26 (deps)                                   | Go service                                                        | ✗                          | Dormant; service; no viewer or tamper evidence                                                |
| Watchtower activity / audkit / sealtrail                                                   | Apache-2.0 / MIT / MIT (SDKs only)                          | 2026                                                                           | SDKs for hosted SaaS                                              | ✗                          | Hosted backends; not self-hostable                                                            |
| Svix / Outpost / Convoy                                                                    | MIT / Apache-2.0 / custom proprietary                       | 2026-11                                                                        | Webhook services                                                  | ✗                          | Different domain (reference for streaming)                                                    |
| Trillian                                                                                   | Apache-2.0                                                  | 2026-11-18                                                                     | Go service                                                        | ✗                          | Maintenance mode; infra, not app audit                                                        |
| Tessera                                                                                    | Apache-2.0                                                  | 2026-11-19                                                                     | Go library                                                        | Go only                    | Primitive (tlog), not an audit product; design reference                                      |
| Rekor / Rekor v2                                                                           | Apache-2.0                                                  | 2026-11-20                                                                     | Public log service                                                | ✗                          | Anchor target, not a product                                                                  |
| immudb                                                                                     | **BSL 1.1**                                                 | 2026-11-20                                                                     | DB server                                                         | Go embed                   | Not permissive; a database, not audit features                                                |
| Amazon QLDB                                                                                | Proprietary                                                 | **EOL 2025-07-31**                                                             | AWS service                                                       | ✗                          | Discontinued                                                                                  |
| pgaudit                                                                                    | PostgreSQL                                                  | 2026-11-17                                                                     | PG extension                                                      | ✗                          | Statement logging for DBAs                                                                    |
| supa_audit / audit-trigger / temporal_tables / pgMemento                                   | Apache-2.0 (archived) / PostgreSQL / MIT & BSD-2 / LGPL-3.0 | 2024 / 2023 / 2025-26 / 2026-04                                                | SQL triggers or extensions                                        | ✗                          | Row diffs, no actor/tenant semantics, no UI                                                   |
| Bemi                                                                                       | **SSPL** (core); LGPL-3.0 (adapters)                        | 2025-12-23                                                                     | CDC worker plus ORM adapters                                      | partial                    | Non-permissive; data-change tracking, not audit events                                        |
| paper_trail / audited                                                                      | MIT                                                         | 2026-09-25 / 2025-11-18                                                        | Rails ORM plugin                                                  | Ruby                       | Single framework, model diffs, no tenant viewer or streaming                                  |
| django-auditlog                                                                            | MIT                                                         | 2026-11-08                                                                     | Django app                                                        | Python                     | Same                                                                                          |
| laravel-auditing / Spatie activitylog                                                      | MIT                                                         | 2026-11-02 / 2026-11-13                                                        | Laravel package                                                   | PHP                        | Same                                                                                          |
| laravel-chronicle                                                                          | MIT                                                         | 2026-11-18                                                                     | Laravel package                                                   | PHP                        | Closest design (chain plus signed checkpoints) but PHP/Laravel only, no tenant viewer or SIEM |
| Audit.NET                                                                                  | MIT                                                         | 2026-09-16                                                                     | .NET framework                                                    | .NET                       | .NET only; no tenant viewer or tamper evidence                                                |
| Prisma / Drizzle / TypeORM / MikroORM plugins                                              | MIT (mostly; some have no LICENSE file; one GPL-3.0)        | 2023–2026                                                                      | ORM extensions                                                    | TS (single ORM)            | Row-change logging only; tiny or stale                                                        |
| `@ddd-ts-kit/audit`, `@better-forge/audit`, `@molecule/api-audit`, `@setu-ts/audit-plugin` | MIT / MIT / Apache-2.0 / MIT                                | 2026                                                                           | Module inside a framework                                         | Only within that framework | Tied to a host framework; no viewer, streaming or tenant model                                |
| GoLogX, witness (Go)                                                                       | MIT                                                         | 2026                                                                           | Go libraries                                                      | Go                         | Tiny; no viewer or tenant control plane                                                       |
| OpenAudit (`@arcari/open-audit`)                                                           | npm MIT, no repo LICENSE                                    | 2025-07-10                                                                     | Node library                                                      | TS                         | Dormant, 3★, basic                                                                            |
| Hoop / Cerbos / Infisical / Tracecat / Permit                                              | MIT / Apache-2.0 / MIT except ee / AGPL / Apache-2.0 (OPAL) | 2026-11                                                                        | Products with _internal_ audit                                    | ✗                          | Not reusable audit-log libraries                                                              |

## 10. Verdict

**No.** I found no project that is at the same time permissive (MIT or Apache), actively
maintained (activity in the last ~6 months), and shaped as an embeddable library for B2B
tenant-facing audit logs. The closest candidates each fail on at least one axis:

- **Retraced** is Apache-2.0, but it is a heavy standalone service (Postgres, Elasticsearch and NSQ)
  kept alive by fix-only commits on a side branch, with no release since 2024-11. Its tamper evidence
  is a per-event hash only.
- **AuditKit** has a strong tamper-evidence design, but it is AGPL-3.0 with a proprietary `ee/`, a
  one-person service-plus-SaaS, has no npm packages, and its React viewer is gone.
- **WorkOS** and **Pangea** are hosted, proprietary services. Pangea's future after the CrowdStrike
  deal is unknown.
- The permissive, active _libraries_ are framework- or ORM-bound record-change trackers: paper_trail,
  audited, django-auditlog, laravel-auditing, Spatie, Audit.NET, and the Prisma/Drizzle/TypeORM
  plugins. **laravel-chronicle** matches the tamper-evidence design (hash chain plus signed
  checkpoints) but is Laravel-only.

None combines a typed multi-tenant event model, pluggable storage, keyset query, a hash chain with
signed checkpoints, an embeddable per-tenant React viewer, SIEM streaming, and adapters for several
frameworks in a TypeScript library. **The gate passes: proceed to build `@xtandard/audit`.**
Borrow from WorkOS (per-action schemas, log streams, retention), Retraced (viewer tokens, enterprise
pull tokens), Pangea, Tessera and AuditKit (checkpoints, proofs, offline verifier). Consider
`xantiagoma/drizzle-audit` as the seed for the Drizzle adapter.
