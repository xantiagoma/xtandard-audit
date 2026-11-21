# Getting started

From zero to a customer-visible, verifiable audit log in your app.

## 1. Install

```sh
bun add @xtandard/audit
# plus the driver peer you use, e.g.:
bun add pg            # storage/postgres
```

## 2. Create the core

```ts
// audit.ts
import { createAuditCore, defineActions, ed25519Signer } from "@xtandard/audit";
import { createPostgresStorage } from "@xtandard/audit/storage/postgres";
import * as v from "valibot";

export const actions = defineActions({
  "member.invited": { targets: ["user"], description: "A member was invited", group: "Members" },
  "member.role_changed": {
    targets: ["user"],
    metadata: v.object({ from: v.string(), to: v.string() }),
    group: "Members",
  },
  "invoice.paid": {
    targets: ["invoice"],
    metadata: v.object({ amount: v.number(), currency: v.string() }),
    group: "Billing",
  },
});

export const audit = createAuditCore({
  storage: createPostgresStorage({ url: process.env.DATABASE_URL! }),
  actions,
  signer: await ed25519Signer(JSON.parse(process.env.AUDIT_SIGNING_KEY!)), // xtandard-audit keygen
  retention: { maxAge: "365d" },
});
```

## 3. Capture request context once

```ts
import { Hono } from "hono";
import { auditContext } from "@xtandard/audit/hono";

app.use(
  auditContext({
    actor: (c) => c.get("user") && { id: c.get("user").id, name: c.get("user").name },
    tenant: (c) => c.get("user")?.orgId,
  }),
);
```

Every `record()` in the request now gets the tenant, actor, IP, user agent and request id.

## 4. Record where things happen

```ts
await audit.record({
  action: "member.role_changed",
  targets: [{ type: "user", id: member.id, name: member.name }],
  metadata: { from: "member", to: "admin" },
});
```

For hot paths that must not wait on the database, use the buffered recorder
(`createRecorder(audit, { onError, fallback })`) — see [Architecture](ARCHITECTURE.md).

## 5. Mount the panel and the portal

```ts
import { auditPanel } from "@xtandard/audit/hono";
import { basicAuth } from "@xtandard/audit/auth/basic";

const panel = auditPanel({
  core: audit,
  basePath: "/audit",
  auth: basicAuth({ users: { admin: process.env.ADMIN_PASSWORD! } }),
  portal: { secret: process.env.PORTAL_SECRET! },
});
app.route("/audit", panel);

// Your route that hands a customer their portal token:
app.get("/api/audit-token", async (c) =>
  c.json({ token: await createPortalToken(process.env.PORTAL_SECRET!, c.get("user").orgId) }),
);
```

Then render `<AuditPortal apiBaseUrl="/audit" token={token} />` in your settings page
([Portal](PORTAL.md)).

## 6. Stream to a SIEM (optional)

```ts
import { datadogSink } from "@xtandard/audit/sinks/datadog";

auditPanel({
  core: audit,
  streams: [{ name: "datadog", sink: datadogSink({ apiKey: process.env.DD_API_KEY! }) }],
});
```

## 7. Verify

```ts
await audit.verify("acme"); // { ok: true, signedThrough: 1200, … }
```

Next: [Integrity](INTEGRITY.md) · [Querying](QUERYING.md) · [Storage](STORAGE.md) · [Deployment](DEPLOYMENT.md)
