# Bun × @xtandard/audit

Mount the audit panel **and** record audit events from a real app — a tiny
multi-tenant "team settings" app where every user action lands in the log, so
you can _see_ the tenant, actor, IP, user agent and request id filled in for you.

## What's here

- **`GET /`** — the team settings page: switch between users of two
  organizations (Acme, Globex), invite members, change roles, pay invoices.
- **`POST /api/members`** → `member.invited`
- **`POST /api/members/:id/role`** → `member.role_changed` (a refused change —
  a viewer trying, or touching the owner — is recorded with `outcome: "failure"`)
- **`POST /api/invoices/:id/pay`** → `invoice.paid`, or `invoice.payment_failed`
  with card `0002`
- **`GET /audit`** — the embedded panel: events, filters, verify, export, the
  action catalog.

No framework: `auditPanel()` gives you `{ fetch, core, … }` and `withAuditContext(fetch, { actor, tenant })` wraps your whole `Bun.serve` handler (the socket IP from `server.requestIP` is the fallback when no trusted proxy header is present).

The actions are a typed catalog (`defineActions` with valibot schemas), so
`record()` autocompletes action names and rejects wrong metadata at compile
time and at runtime. The handlers only say _what_ happened:

```ts
await audit.record({
  action: "member.role_changed",
  targets: [{ type: "user", id: member.id, name: member.name }],
  metadata: { from: "member", to: "admin" },
});
```

Storage: memory storage (gone on restart). The app's own data (users, invoices) is in memory and
resets on restart; the audit log does not.

## Run it

```bash
bun install                 # links @xtandard/audit (build the repo root first: bun run build)
bun run start               # honors PORT; defaults to 3000
# or from the repo root:    bun run examples:bun
```

Then open <http://localhost:3000>.

## The loop

1. On <http://localhost:3000>, as **Ada (owner @ acme)**: invite someone, make
   Alan an admin, pay an invoice with `4242` and another with `0002`.
2. Switch to **Lena (viewer @ globex)** and try to change a role — refused, and
   recorded as a failure in **globex**'s log.
3. Open <http://localhost:3000/audit>: two tenants, each event attributed to the
   right user with IP, user agent and request id; filter by `invoice.*` or
   `outcome: failure`, verify a tenant's chain, export CSV.

Or with curl (`x-demo-user` picks the fake session):

```bash
curl -s -X POST localhost:3000/api/members -H 'x-demo-user: usr_ada' \
  -H 'content-type: application/json' -d '{"email":"noor@acme.com","role":"member"}'
curl -s -X POST localhost:3000/api/invoices/inv_acme_2/pay -H 'x-demo-user: usr_ada' \
  -H 'content-type: application/json' -d '{"card":"0002"}'                       # 402, recorded
curl -s 'localhost:3000/audit/api/tenants/acme/events?limit=3' | jq '.items[] | {action, outcome, actor: .actor.name, ip: .context.ip}'
curl -s localhost:3000/audit/api/tenants/acme/verify | jq '{ok, checked}'
```

## Files

- [`src/index.ts`](./src/index.ts) — the panel, the auth + audit-context middleware, the routes.
- [`src/demo.ts`](./src/demo.ts) — the action catalog, the in-memory app, the three audited actions, the page.
