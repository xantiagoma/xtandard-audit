# standalone-docker × @xtandard/audit

Run the standalone image — panel, HTTP API, customer portal, streams and the
retention timer in one container — next to a Postgres that holds the log. No
code, only environment variables.

## What's here

- **`docker-compose.yml`** — `ghcr.io/xantiagoma/xtandard-audit` + `postgres:16`,
  with basic auth, an Ed25519 signing key, a portal secret and 365-day retention
  configured via env.
- **`.env.example`** — the two secrets you supply.

## Run it

```bash
cp .env.example .env
bunx @xtandard/audit keygen          # paste line 1 (the private JWK) as AUDIT_SIGNING_KEY
docker compose up
```

Then open <http://localhost:3080> and sign in with `admin` / `changeme`.

Everything is configured through the same env contract as the CLI's `serve`
command (`STORAGE_DRIVER`, `AUTH_MODE`, `AUDIT_SIGNING_KEY`, `PORTAL_SECRET`,
`RETENTION_*`, `AUDIT_STREAMS`, `STREAM_RUNNER`, …) — see
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md). Generate a real password hash
and set it as `AUTH_PASSWORD_HASH` instead of `AUTH_PASSWORD`:

```bash
bun -e "import('@xtandard/audit/auth/basic').then(m => m.hashPassword('secret').then(console.log))"
```

## The loop

1. Record from anywhere that can reach the container — your app over the HTTP
   API, or the CLI pointed at the same Postgres:

   ```bash
   curl -u admin:changeme -X POST localhost:3080/api/tenants/acme/events \
     -H 'content-type: application/json' \
     -d '{"action":"invoice.paid","actor":{"id":"usr_ada","name":"Ada"},"targets":[{"type":"invoice","id":"inv_1"}],"metadata":{"amount":4900}}'

   STORAGE_DRIVER=postgres DATABASE_URL=postgres://audit:audit@localhost:5432/audit \
     bunx @xtandard/audit record --tenant acme --action user.login --actor usr_ada
   ```

   (The compose file does not publish Postgres' port; add `ports: ["5432:5432"]`
   to the `postgres` service for the CLI variant.)

2. Browse, filter, export and verify in the panel; sign a checkpoint
   (`POST /api/tenants/acme/checkpoints`) and check the chain
   (`GET /api/tenants/acme/verify`).
3. Hand a customer their own view: mint a portal token with
   `createPortalToken(PORTAL_SECRET, "acme")` in your app and open
   `http://localhost:3080/?token=<token>` (or embed `<AuditPortal>`; see
   [`../portal-embed`](../portal-embed)).

For the split topology — your web tier records directly into Postgres and this
container only serves the panel, portal and streams — point your app's
`createPostgresStorage` at the same database ([Deployment](../../docs/DEPLOYMENT.md#shapes)).

## Files

- [`docker-compose.yml`](./docker-compose.yml) — the two services, wired.
- [`.env.example`](./.env.example) — the secrets.
