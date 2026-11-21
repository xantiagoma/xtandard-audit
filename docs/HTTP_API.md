# HTTP API

The panel's JSON API, mounted under the panel's `basePath` (e.g. `/audit`). The admin UI, the
portal and the React embeds use it; so can you (it is also served as OpenAPI 3.1 at
`{basePath}/api/openapi.json`). Every route goes through authentication, then authorization with
the action/resource listed (see [Authorization](./AUTHORIZATION.md)); portal-token principals are
force-scoped to their tenant and their token's view filter (see [Portal](./PORTAL.md)).

Errors are JSON `{ "error": string, ...extra }`: `400` bad query/cursor, `401` unauthenticated or
bad portal token, `403` denied (authorization, portal scope, `HookDeniedError`), `404`, `409`
conflict (`ConflictError`, `SignerRequiredError`), `422` validation (`{ errors: ValidationIssue[] }`),
`423` readonly. Errors are recognised by name, so an error class from another bundle maps the same.

A `:tenant` or event `:id` path parameter that could never have been recorded (a padded `acme%20`,
`..`, an id that is not `evt_…`) is a `404`, as is a malformed `%` escape; a `?tenant=` like it is
a `400`. Recording (`POST /api/tenants/:tenant/events`) keeps its `422` for an invalid tenant.
`GET {basePath}/healthcheck` answers `{ "ok": true }` inside the panel, a non-API path answers
`405` with `Allow: GET, HEAD` to other methods, and the OpenAPI `info.version` is the package
version.

## Query parameters (event listing and export)

The [query model](./QUERYING.md) as URL parameters. List parameters accept repetition
(`?actions=a&actions=b`) or commas (`?actions=a,b`).

| Param            | Type                                        |
| ---------------- | ------------------------------------------- |
| `actions`        | list; `invoice.*` = family                  |
| `excludeActions` | list                                        |
| `actorId`        | string                                      |
| `actorType`      | string                                      |
| `targetType`     | string                                      |
| `targetId`       | string                                      |
| `outcome`        | `success` \| `failure`                      |
| `from`, `to`     | ISO-8601 (`from` inclusive, `to` exclusive) |
| `search`         | string                                      |
| `order`          | `desc` (default) \| `asc`                   |
| `limit`          | 1–500, default 50                           |
| `cursor`         | opaque, from `pageInfo.endCursor`           |

## Routes

| Method & path                                   | Action                 | Resource                             | Response                                                                                     |
| ----------------------------------------------- | ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `GET /config` (also `/api/config`)              | —                      | —                                    | `PanelConfig` (below)                                                                        |
| `GET /api/openapi.json`                         | public                 | —                                    | OpenAPI 3.1                                                                                  |
| `GET /api/integrity/keys`                       | public, CORS `*`       | —                                    | JWKS `{ keys }`                                                                              |
| `GET /api/overview`                             | `tenant:read`          | `{ type: "tenant" }`                 | `Overview`                                                                                   |
| `GET /api/tenants`                              | `tenant:read`          | `{ type: "tenant" }`                 | `AuditTenant[]`                                                                              |
| `GET /api/tenants/:tenant`                      | `tenant:read`          | `{ type: "tenant", tenant }`         | `AuditTenant`                                                                                |
| `GET /api/events?…`                             | `event:read`           | `{ type: "event", tenant? }`         | `AuditPage` (cross-tenant; `tenant=` ok)                                                     |
| `GET /api/tenants/:tenant/events?…`             | `event:read`           | `{ type: "event", tenant }`          | `AuditPage`                                                                                  |
| `GET /api/tenants/:tenant/events/:id`           | `event:read`           | `{ type: "event", tenant, eventId }` | `AuditEvent`                                                                                 |
| `POST /api/tenants/:tenant/events`              | `event:record`         | `{ type: "event", tenant }`          | `201` `AuditEvent` (body: one input) or `AuditEvent[]` (body: array)                         |
| `POST /api/tenants/:tenant/events/:id/erase`    | `event:erase`          | `{ type: "event", tenant, eventId }` | `AuditEvent` (body `{ sections?, reason? }`)                                                 |
| `GET /api/tenants/:tenant/export?format=…&…`    | `event:export`         | `{ type: "event", tenant }`          | stream; `format` = `csv` \| `json` \| `jsonl` \| `bundle`; `content-disposition: attachment` |
| `GET /api/tenants/:tenant/verify?fromSeq&toSeq` | `integrity:read`       | `{ type: "integrity", tenant }`      | `VerifyReport`                                                                               |
| `GET /api/tenants/:tenant/checkpoints`          | `integrity:read`       | `{ type: "integrity", tenant }`      | `AuditCheckpoint[]`                                                                          |
| `POST /api/tenants/:tenant/checkpoints`         | `integrity:checkpoint` | `{ type: "integrity", tenant }`      | `201` `AuditCheckpoint`                                                                      |
| `POST /api/tenants/:tenant/prune`               | `retention:prune`      | `{ type: "retention", tenant }`      | `PruneResult`                                                                                |
| `POST /api/prune`                               | `retention:prune`      | `{ type: "retention" }`              | `PruneResult[]`                                                                              |
| `GET /api/actions`                              | `action:read`          | `{ type: "action" }`                 | `ActionDefinition[]`                                                                         |
| `PUT /api/actions/:name`                        | `action:update`        | `{ type: "action", name }`           | `ActionDefinition`                                                                           |
| `DELETE /api/actions/:name`                     | `action:delete`        | `{ type: "action", name }`           | `204`                                                                                        |
| `GET /api/streams`                              | `stream:read`          | `{ type: "stream" }`                 | `StreamStatus[]`                                                                             |
| `POST /api/streams/:name/retry?tenant=`         | `stream:retry`         | `{ type: "stream", name }`           | `204`                                                                                        |

```ts
interface PanelConfig {
  title: string;
  basePath: string;
  readonly: boolean;
  logoUrl?: string;
  /** True for portal-token principals: the UI renders the portal chrome. */
  portal: boolean;
  /** The portal principal's tenant. */
  tenant?: string;
  principal: { id: string; name?: string; email?: string } | null;
  /** Actions this principal may perform (the UI hides what it cannot do). */
  allowed: AuditAction[];
  features: { signer: boolean; streams: boolean };
}

interface Overview {
  tenants: number;
  events: number;
  recent: AuditEvent[]; // latest 10 across tenants
  streams: StreamStatus[];
}
```

Mutating actions (`event:record`, `event:erase`, `integrity:checkpoint`, `retention:prune`,
`action:update`, `action:delete`, `stream:retry`) answer `423` when the panel is readonly.

Notes on individual routes:

- `POST /api/tenants/:tenant/events` — the tenant comes from the path (a body `tenant` that differs
  is a `422`); a missing `actor` defaults to the authenticated principal (`type: "api"`).
- `GET /api/tenants/:tenant/export` — `format` defaults to `csv`; `cursor`/`limit` are ignored
  (exports stream every match, up to 100 000 events). The filename is
  `<tenant>-audit-<YYYY-MM-DD>.<csv|json|jsonl|bundle.jsonl>` (tenant characters outside
  `[A-Za-z0-9._-]` become `_`). The export notes itself (`audit_log.exported`) before streaming, so
  the self-audit event of this very export is part of it.
- Portal principals: a client parameter outside the token's view filter yields an empty result
  (never a `403`, never a wider view); an event outside it reads as `404`; `format=bundle` is a
  `403` for filtered tokens (a bundle is the whole chain); `GET /api/tenants/:tenant` omits `count`
  for filtered tokens.
- Error bodies carry a machine-readable `code` where one applies: `READONLY`, `HOOK_DENIED`,
  `PORTAL_TOKEN`, `BAD_QUERY`, `BAD_JSON`, `CONFLICT`, `SIGNER_REQUIRED`, `VALIDATION`; `403`
  authorization denials carry the denied `action`.
