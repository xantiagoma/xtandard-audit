# Authorization

May this principal do this? Evaluated per request against an action + resource pair; three providers ship.

## Actions and resources

```ts
type AuditAction =
  | "tenant:read"
  | "event:read"
  | "event:record"
  | "event:export"
  | "event:erase"
  | "integrity:read"
  | "integrity:checkpoint"
  | "action:read"
  | "action:update"
  | "action:delete"
  | "retention:prune"
  | "stream:read"
  | "stream:retry";

type AuditResource =
  | { type: "tenant"; tenant?: string }
  | { type: "event"; tenant?: string; eventId?: string }
  | { type: "integrity"; tenant: string }
  | { type: "action"; name?: string }
  | { type: "retention"; tenant?: string }
  | { type: "stream"; name?: string };
```

Resources carry scope (`tenant`, `eventId`, `name`) so a provider can answer per-tenant questions, not just per-verb ones. An absent `tenant` / `name` means "across all": the tenant list, the cross-tenant event search (`GET /api/events` without `tenant=`), a global prune, the stream list. The route → action/resource table is in the [HTTP API](./HTTP_API.md).

`MUTATING_ACTIONS` / `isMutatingAction` are exported for "read-only vs write" policies: `event:record`, `event:erase`, `integrity:checkpoint`, `action:update`, `action:delete`, `retention:prune`, `stream:retry`. Exporting is a read (it is self-audited, but does not change the log's content). A readonly panel answers `423` for every mutating action before your provider is asked.

## What the UI is told: `/config` `allowed`

`GET /config` asks your provider once per action and returns the granted ones as `allowed`, so the UI hides what the principal cannot do. It asks with the "listing" resource of each type (`{ type: "event" }`, `{ type: "tenant" }`, …) and `{ type: "integrity", tenant: "*" }` for integrity (whose resource always names a tenant). A provider that only grants specific tenants should treat those as "may act on some tenant"; the real routes are still authorized per resource.

## Bundled providers

### `@xtandard/audit/authorization/none` (default)

Everything allowed. Pair only with real auth or a private network.

### `@xtandard/audit/authorization/roles`

```ts
import { rolesAuthorization, DEFAULT_ROLE_POLICY } from "@xtandard/audit/authorization/roles";

const authorization = rolesAuthorization(); // DEFAULT_ROLE_POLICY
```

Maps `principal.roles` through a policy:

| Role      | Grant                                                                           |
| --------- | ------------------------------------------------------------------------------- |
| `admin`   | `"*"` — everything                                                              |
| `auditor` | `AUDITOR_ACTIONS` — every `*:read`, plus `event:export`, `integrity:checkpoint` |
| `viewer`  | `READ_ACTIONS` — every `*:read` action (no export)                              |

Supply your own `policy` to rename roles or narrow grants; unknown roles grant nothing; a principal needs at least one granting role per action. `readonly: true` denies every mutating action regardless of role.

```ts
rolesAuthorization({
  policy: {
    support: ["tenant:read", "event:read"],
    compliance: ["event:read", "event:export", "event:erase"], // GDPR erasure desk
  },
});
```

### `@xtandard/audit/authorization/delegated`

```ts
import { delegatedAuthorization } from "@xtandard/audit/authorization/delegated";

const authorization = delegatedAuthorization({
  async authorize({ principal, action, resource }) {
    return myPolicyEngine.check(principal?.id, action, resource); // boolean
  },
});
```

Bridge to whatever your app uses (Casbin, OPA, Cedar, hand-rolled ACLs). A provider that throws answers 500.

## Portal principals bypass all of this — on purpose

A request authenticated by a portal token is authorized by the portal's own force-scoping (the token's tenant only, `portal.allow` actions only — default `DEFAULT_PORTAL_ACTIONS` — the global action catalog read-only, streams never); your authorization provider is never consulted for it. Defense in depth: a bug in host policy code can't widen a customer's portal into another tenant. See ADR 0006 and [Portal](./PORTAL.md).
