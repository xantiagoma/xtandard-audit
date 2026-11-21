/**
 * Elysia + @xtandard/audit — the admin panel AND an app that records on real
 * user actions.
 *
 *   bun add elysia @xtandard/audit valibot
 *   bun run src/index.ts
 *
 * Then:
 *   - GET  /                        → a "team settings" page (invite, change role, pay invoice).
 *   - POST /api/members             → records `member.invited`.
 *   - POST /api/members/:id/role    → records `member.role_changed` (denied attempts as failures).
 *   - POST /api/invoices/:id/pay    → records `invoice.paid` / `invoice.payment_failed`.
 *   - GET  /audit                   → the embedded panel (events, verify, export, catalog).
 *
 * The audit log lives in SQLite (`bun:sqlite`, native event log with indexed
 * queries) — a natural fit on Bun, where Elysia runs.
 */
import { Elysia } from "elysia";
import { auditContext, auditPanel } from "@xtandard/audit/elysia";
import { createSqliteStorage } from "@xtandard/audit/storage/sqlite";
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

const port = Number(process.env.PORT) || 3000;

await Bun.$`mkdir -p .audit`.quiet();
const audit = createAudit(createSqliteStorage({ path: "./.audit/audit.sqlite" }));

// The panel reuses the typed core (one core per process).
const panel = auditPanel({ core: audit, basePath: "/audit", title: "Acme Audit Log" });

const send = (r: Result) => Response.json(r.body, { status: r.status });
const input = (body: unknown) => (body ?? {}) as Record<string, string>;

new Elysia()
  // Your auth plugin (here: a fake session) derives the user …
  .derive({ as: "global" }, ({ request }) => ({ user: currentUser(request.headers) }))
  // … and the audit context plugin, registered after it, attributes every record().
  .use(
    auditContext({
      actor: (ctx) => actorOf(ctx.user as User),
      tenant: (ctx) => (ctx.user as User).orgId,
    }),
  )
  .get(
    "/",
    () => new Response(renderDemoPage("/audit"), { headers: { "content-type": "text/html; charset=utf-8" } }),
  )
  .get("/api/me", ({ user }) => send(me(user)))
  .post("/api/members", async ({ user, body }) => send(await inviteMember(audit, user, input(body))))
  .post("/api/members/:id/role", async ({ user, params, body }) =>
    send(await changeRole(audit, user, params.id, input(body))),
  )
  .post("/api/invoices/:id/pay", async ({ user, params, body }) =>
    send(await payInvoice(audit, user, params.id, input(body))),
  )
  .mount("/audit", panel)
  .listen(port);

console.log(`Elysia listening on http://localhost:${port} (app at /, audit panel at /audit)`);
