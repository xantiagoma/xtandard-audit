/**
 * Plain `Bun.serve` + @xtandard/audit — no framework: the panel's fetch
 * handler, your routes, and `withAuditContext` wrapping the whole thing.
 *
 *   bun add @xtandard/audit valibot
 *   bun run src/index.ts
 *
 * Then:
 *   - GET  /                        → a "team settings" page (invite, change role, pay invoice).
 *   - POST /api/members             → records `member.invited`.
 *   - POST /api/members/:id/role    → records `member.role_changed` (denied attempts as failures).
 *   - POST /api/invoices/:id/pay    → records `invoice.paid` / `invoice.payment_failed`.
 *   - GET  /audit                   → the embedded panel (events, verify, export, catalog).
 *
 * `withAuditContext(fetch, { actor, tenant })` opens a request-scoped audit
 * context around your handler; the socket IP (`server.requestIP`) is the
 * fallback when no trusted proxy header is present.
 */
import { auditPanel, withAuditContext } from "@xtandard/audit/bun";
import { createMemoryStorage } from "@xtandard/audit/storage/memory";
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
} from "./demo.ts";

// Memory storage: nothing to set up, gone on restart. Swap for any driver.
const audit = createAudit(createMemoryStorage());
const panel = auditPanel({ core: audit, basePath: "/audit", title: "Acme Audit Log" });

const send = (r: Result) => Response.json(r.body, { status: r.status });
const body = async (req: Request) =>
  ((await req.json().catch(() => null)) ?? {}) as Record<string, string>;

/** Your app's routes — a hand-rolled router is plenty for four endpoints. */
async function app(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const user = currentUser(request.headers);
  if (request.method === "GET" && pathname === "/") {
    return new Response(renderDemoPage("/audit"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "GET" && pathname === "/api/me") return send(me(user));
  if (request.method === "POST" && pathname === "/api/members") {
    return send(await inviteMember(audit, user, await body(request)));
  }
  const role = /^\/api\/members\/([^/]+)\/role$/.exec(pathname);
  if (request.method === "POST" && role) {
    return send(await changeRole(audit, user, role[1]!, await body(request)));
  }
  const pay = /^\/api\/invoices\/([^/]+)\/pay$/.exec(pathname);
  if (request.method === "POST" && pay) {
    return send(await payInvoice(audit, user, pay[1]!, await body(request)));
  }
  return new Response("not found", { status: 404 });
}

const port = Number(process.env.PORT) || 3000;
Bun.serve({
  port,
  fetch: withAuditContext(
    (request) =>
      new URL(request.url).pathname.startsWith("/audit") ? panel.fetch(request) : app(request),
    {
      actor: (request) => actorOf(currentUser(request.headers)),
      tenant: (request) => currentUser(request.headers).orgId,
    },
  ),
});

console.log(`Bun.serve on http://localhost:${port} (app at /, audit panel at /audit)`);
