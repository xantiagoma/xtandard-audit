# Auth × @xtandard/audit

Authentication ("who is this request?") and authorization ("may they do it?")
are two small **pluggable contracts** — plus portal tokens, a third lane for
customer-scoped access. This one example mounts the panel with a different
setup per `AUTH_DEMO` mode, with a portal-token mint route running side by
side in every mode.

## What's here

| `AUTH_DEMO` | Authentication     | Authorization                                                          |
| ----------- | ------------------ | ---------------------------------------------------------------------- |
| `none`      | none (open)        | `noAuthorization()` — everything allowed                               |
| `basic`     | HTTP Basic         | roles; one **encrypted** (scrypt) user, one **plaintext** (dev only)   |
| `delegated` | `X-API-Key` lookup | roles; `delegatedAuth` — bring-your-own auth is one `Request → Principal` |
| `roles`     | Basic, 3 users     | `rolesAuthorization()` — **admin / auditor / viewer** (the default policy) |

The default role policy: `admin` → everything; `auditor` → every read, plus
export and signing checkpoints; `viewer` → reads only. Erasure and pruning stay
with admins.

And in **every** mode:

- **`POST /portal-token?tenant=acme[&hide=support.*]`** — a host route that mints
  an `audpt_…` token with `createPortalToken(secret, tenant, { filter })`. The
  panel (mounted with `portal: { secret }`) accepts it as a bearer and
  force-scopes it to that tenant; `hide` adds a view filter AND-ed server-side
  into every query, export and read. Your auth/authorization providers are never
  consulted for portal principals.

## Run it

```bash
bun install
AUTH_DEMO=roles bun run start    # default; modes above
# or from the repo root:  AUTH_DEMO=basic bun run examples:auth
```

## The loop

```bash
API=localhost:3000/api

# none — anything works
AUTH_DEMO=none bun run start
curl -s $API/tenants                                                    # 200

# basic — encrypted (admin/s3cret) or plaintext (dev/dev)
AUTH_DEMO=basic bun run start
curl -su admin:s3cret $API/tenants                                      # 200
curl -so/dev/null -w '%{http_code}\n' -u admin:wrong $API/tenants       # 401

# delegated — API keys: key-admin | key-auditor | key-viewer
AUTH_DEMO=delegated bun run start
curl -s -H 'x-api-key: key-auditor' $API/tenants/acme/events            # 200

# roles — alice/alice (admin), bob/bob (auditor), carol/carol (viewer)
AUTH_DEMO=roles bun run start
curl -so/dev/null -w '%{http_code}\n'                $API/tenants                          # 401
curl -so/dev/null -w '%{http_code}\n' -u carol:carol $API/tenants/acme/events              # 200 viewer reads
curl -so/dev/null -w '%{http_code}\n' -u carol:carol "$API/tenants/acme/export?format=csv" # 403 viewer can't export
curl -so/dev/null -w '%{http_code}\n' -u bob:bob     "$API/tenants/acme/export?format=csv" # 200 auditor can
curl -so/dev/null -w '%{http_code}\n' -u bob:bob -X POST $API/tenants/acme/events \
  -H 'content-type: application/json' -d '{"action":"x.y","actor":{"id":"bob"}}'           # 403 auditor can't record
curl -so/dev/null -w '%{http_code}\n' -u alice:alice -X POST $API/tenants/acme/events \
  -H 'content-type: application/json' -d '{"action":"x.y","actor":{"id":"alice"}}'         # 201 admin can

# portal tokens — every mode; scoped to ONE tenant, optionally filtered
TOKEN=$(curl -s -X POST 'localhost:3000/portal-token?tenant=acme&hide=support.*' | jq -r .token)
curl -s -H "authorization: Bearer $TOKEN" $API/tenants/acme/events | jq '[.items[].action]'  # no support.*
curl -so/dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" \
  $API/tenants/globex/events                                                              # 403 cross-tenant
curl -s -H "authorization: Bearer $TOKEN" localhost:3000/config | jq '{portal, tenant, allowed}'
```

In your own app:

```ts
import { createFetchHandler } from "@xtandard/audit";
import { basicAuth } from "@xtandard/audit/auth/basic";
import { rolesAuthorization } from "@xtandard/audit/authorization/roles";

createFetchHandler({
  storage,
  auth: basicAuth({ users: [{ username: "ops", passwordHash, roles: ["admin"] }] }),
  authorization: rolesAuthorization(), // admin / auditor / viewer
  portal: { secret: process.env.PORTAL_SECRET! },
});
```

Generate a password hash:
`bun -e "import('@xtandard/audit/auth/basic').then(m => m.hashPassword('pw').then(console.log))"`.
Both contracts also have a `delegated` built-in (`auth/delegated`,
`authorization/delegated`) to call out to your own session store or policy
engine. Details: [Auth](../../docs/AUTH.md), [Authorization](../../docs/AUTHORIZATION.md),
[Portal](../../docs/PORTAL.md).

## Files

- [`src/index.ts`](./src/index.ts) — the mode switch, the panel, a little seed, and the portal mint route.
