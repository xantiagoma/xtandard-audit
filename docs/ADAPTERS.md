# Adapters

One panel, four mounts — plus a request-context middleware per framework. Every adapter wraps `createFetchHandler` and exposes the same extras: `.core` (the operations surface — call `core.record()` from your routes), `.streams` (the stream runner, started by default when `streams` are declared; `streamRunner: false` for split deployments), `.openapi()` (merge into your own docs) and `.close()` (stop the runner and the retention timer).

All adapters take the same `AuditPanelOptions` (`storage` | `core`, `basePath`, `auth`, `authorization`, `portal`, `readonly`, `title`, `logoUrl`, `uiDir`, `hooks`, `onHookError`, `retention`, `signer`, `actions`, `transforms`, `cors`, `streams`, `streamRunner`, `maintenance`). Export responses are **streams** in every adapter — a large CSV or bundle is never buffered in memory.

| Option         | Default              | What it does                                                                                |
| -------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `streams`      | none                 | SIEM/archive streams (ADR 0008); the panel creates a runner and shows lag/errors in the UI  |
| `streamRunner` | started              | runner tuning (`interval`, `maxBackoff`, `lease`, `onError`), or `false` to not run it here |
| `maintenance`  | `{ interval: "1h" }` | prune on a timer when the core has `retention`; `false` to prune from a cron instead        |
| `cors`         | off                  | answer preflights + add `Access-Control-*` headers (cross-origin portal embeds)             |

## Request context: `auditContext()`

Every adapter subpath also exports a middleware that opens an `AsyncLocalStorage` scope per request (ADR 0013): it captures the IP, user agent and request id from the request, resolves the actor and tenant from **your** auth, and every `audit.record()` downstream picks them up — no threading through call sites.

```ts
auditContext({
  actor: (ctx) => ({ id: user.id, name: user.name, email: user.email }), // or null
  tenant: (ctx) => user.orgId,
  context: (ctx) => ({ sessionId }), // extra keys, optional
  trustProxy: true, // x-forwarded-for / cf-connecting-ip / x-real-ip (default true)
  requestIdHeader: "x-request-id", // default: x-request-id, then cf-ray
});
```

The callbacks receive the framework's own context (Hono's `c`, Express's `req`, Elysia's `ctx`, Bun's `Request`) and may be async. Explicit fields passed to `record()` always win over the scope. Set `trustProxy: false` when the app is reachable without a proxy — clients could otherwise spoof their IP; the socket address is then used where the framework exposes it (Express, Bun, Elysia on Bun).

## Bun

```ts
import { auditPanel, withAuditContext } from "@xtandard/audit/bun";

const audit = auditPanel({ storage, basePath: "/audit" });

Bun.serve({
  port: 3000,
  fetch: withAuditContext(
    (request, server) =>
      new URL(request.url).pathname.startsWith("/audit") ? audit.fetch(request) : app(request),
    {
      actor: async (request) => (await getSession(request))?.user ?? null,
      tenant: async (request) => (await getSession(request))?.orgId,
    },
  ),
});
```

`auditContext(options)` is the curried form: `auditContext(options)(fetch)`.

## Elysia

```ts
import { Elysia } from "elysia";
import { auditContext, auditPanel } from "@xtandard/audit/elysia";

const audit = auditPanel({ storage, basePath: "/audit" });
new Elysia()
  .use(authPlugin) // derives `user`
  .use(auditContext({ actor: ({ user }) => user, tenant: ({ user }) => user?.orgId }))
  .mount("/audit", audit)
  .listen(3000);
```

`auditContext` is a plugin that resolves the scope in a global `derive` and enters it in a synchronous `onBeforeHandle`, so it reaches the handler. Register it **after** the plugin that derives your user.

For end-to-end typed clients (Eden), use the typed plugin instead — it declares every API route with schemas:

```ts
import { auditElysia } from "@xtandard/audit/elysia";

const app = new Elysia().use(auditElysia({ prefix: "/audit", storage })).listen(3000);
export type App = typeof app; // → treaty<App> infers the whole audit API
// client.audit!.api.tenants({ tenant: "acme" }).events.get({ query: { actions: "invoice.*" } })
```

### Elysia 2 — `@xtandard/audit/elysia2`

Elysia 2 (currently `elysia@rc`) changed two things that matter to the typed plugin: routes take `(path, hook, handler)` instead of `(path, handler, hook)`, and the `Elysia` class generics changed — so a plugin's `.d.ts` built against one major doesn't type-check (or feed Eden) on the other. `@xtandard/audit/elysia2` is the same surface — `auditPanel`, `auditElysia`, `auditContext` — built and typed against Elysia 2:

```ts
import { Elysia } from "elysia"; // 2.x
import { auditElysia } from "@xtandard/audit/elysia2";

const app = new Elysia().use(auditElysia({ prefix: "/audit", storage })).listen(3000);
export type App = typeof app;
```

```ts
import { treaty } from "@elysia/eden"; // Elysia 2's Eden (was @elysiajs/eden)
const client = treaty<App>("localhost:3000");
await client.audit!.api.tenants.get();
```

| Elysia | Import from               | Eden client      |
| ------ | ------------------------- | ---------------- |
| 1.x    | `@xtandard/audit/elysia`  | `@elysiajs/eden` |
| 2.x    | `@xtandard/audit/elysia2` | `@elysia/eden`   |

`auditPanel` (the `.mount()` handler) is version-agnostic and works from either import; the typed `auditElysia` plugin and `auditContext` are tied to a major.

## Hono

```ts
import { Hono } from "hono";
import { auditContext, auditPanel } from "@xtandard/audit/hono";

const app = new Hono();
app.use("*", authMiddleware); // sets c.var.user
app.use("*", auditContext({ actor: (c) => c.get("user"), tenant: (c) => c.get("user")?.orgId }));
app.route("/audit", auditPanel({ storage, basePath: "/audit" }));
```

The middleware wraps `await next()` in the scope.

## Express

```ts
import express from "express";
import { auditContext, auditPanel } from "@xtandard/audit/express";

const app = express();
app.use("/audit", auditPanel({ storage, basePath: "/audit" })); // BEFORE express.json()/body-parser
app.use(express.json());
app.use(passport.session());
app.use(auditContext({ actor: (req) => req.user, tenant: (req) => req.user?.orgId }));
```

The Express adapter bridges Node req/res to fetch semantics: request bodies are buffered (they are small JSON), **responses are streamed** with backpressure (exports), and a client disconnect cancels the export. Mount it before any body parser; if one already consumed the stream, the adapter re-serializes `req.body`, but mounting first is the reliable order. `auditContext` wraps `next()` in the scope.

## Sharing one core

Mount the panel and record from the same process by reusing the adapter's `core` — don't create a second core over the same storage in the same process (per-tenant appends are serialized per core; two cores in one process race on the chain head and retry):

```ts
const audit = auditPanel({ storage, basePath: "/audit" });
app.post("/invoices/:id/pay", async (req) => {
  await payInvoice(req.params.id);
  await audit.core.record({
    action: "invoice.paid",
    targets: [{ type: "invoice", id: req.params.id }],
  });
});
```
