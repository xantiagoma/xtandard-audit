/**
 * Hono + @xtandard/audit — the admin panel AND an app that records on real
 * user actions.
 *
 *   bun add hono @xtandard/audit valibot
 *   bun run src/index.ts
 *
 * Then:
 *   - GET  /                        → a "team settings" page (invite, change role, pay invoice).
 *   - POST /api/members             → records `member.invited`.
 *   - POST /api/members/:id/role    → records `member.role_changed` (denied attempts as failures).
 *   - POST /api/invoices/:id/pay    → records `invoice.paid` / `invoice.payment_failed`.
 *   - GET  /audit                   → the embedded panel (events, verify, export, catalog).
 *
 * `auditContext()` resolves the tenant and actor from the session and captures
 * the IP, user agent and request id, so each `record()` only says what happened.
 */
import { Hono } from "hono";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { auditContext, auditPanel } from "@xtandard/audit/hono";
import { createFileStorage } from "@xtandard/audit/storage/file";
import {
  actorOf,
  changeRole,
  createAudit,
  currentUser,
  inviteMember,
  me,
  payInvoice,
  renderDemoPage,
  type Result,
  type User,
} from "./demo.ts";

// File storage survives restarts; swap for postgres/sqlite/… without touching the rest.
const audit = createAudit(createFileStorage({ dir: "./.audit" }));

// The panel reuses the typed core (one core per process — ADR 0002's ordering guarantee).
const panel = auditPanel({ core: audit, basePath: "/audit", title: "Acme Audit Log" });

const app = new Hono<{ Variables: { user: User } & RequestIdVariables }>();

// Hono's request id (the incoming X-Request-Id, or a fresh one) — correlates audit events with logs.
app.use("*", requestId());
// Your auth middleware (here: a fake session) …
app.use("*", async (c, next) => {
  c.set("user", currentUser(c.req.raw.headers));
  await next();
});
// … then the audit context: every record() below is attributed to this user and org.
app.use(
  "*",
  auditContext({
    actor: (c) => actorOf(c.get("user")),
    tenant: (c) => c.get("user").orgId,
    context: (c) => ({ requestId: c.get("requestId") }),
  }),
);

// Plain web Responses — Hono handlers can return them directly.
const send = (r: Result) => Response.json(r.body, { status: r.status });
const body = async (req: Request) => ((await req.json().catch(() => null)) ?? {}) as Record<string, string>;

app.get("/", (c) => c.html(renderDemoPage("/audit")));
app.get("/api/me", (c) => send(me(c.get("user"))));
app.post("/api/members", async (c) =>
  send(await inviteMember(audit, c.get("user"), await body(c.req.raw))),
);
app.post("/api/members/:id/role", async (c) =>
  send(await changeRole(audit, c.get("user"), c.req.param("id"), await body(c.req.raw))),
);
app.post("/api/invoices/:id/pay", async (c) =>
  send(await payInvoice(audit, c.get("user"), c.req.param("id"), await body(c.req.raw))),
);

// The adapter returns a Hono sub-app, so it composes with `route()`.
app.route("/audit", panel);

const port = Number(process.env.PORT) || 3000;
console.log(`Hono listening on http://localhost:${port} (app at /, audit panel at /audit)`);
export default { port, fetch: app.fetch };
