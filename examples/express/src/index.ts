/**
 * Express + @xtandard/audit — the admin panel AND an app that records on real
 * user actions.
 *
 *   bun add express @xtandard/audit valibot
 *   bun run src/index.ts
 *
 * Then:
 *   - GET  /                        → a "team settings" page (invite, change role, pay invoice).
 *   - POST /api/members             → records `member.invited`.
 *   - POST /api/members/:id/role    → records `member.role_changed` (denied attempts as failures).
 *   - POST /api/invoices/:id/pay    → records `invoice.paid` / `invoice.payment_failed`.
 *   - GET  /audit                   → the embedded panel (events, verify, export, catalog).
 *
 * Mount the panel BEFORE any body-parsing middleware — it reads the raw body.
 */
import express, { type Request, type Response } from "express";
import { auditContext, auditPanel } from "@xtandard/audit/express";
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

const app = express();

// Panel FIRST (it reads the raw request body), then your own parsers and routes.
app.use("/audit", auditPanel({ core: audit, basePath: "/audit", title: "Acme Audit Log" }));
app.use(express.json());

// Your auth middleware (here: a fake session) sets req.user …
type AuthedRequest = Request & { user: User };
app.use((req, _res, next) => {
  (req as AuthedRequest).user = currentUser(new Headers(req.headers as Record<string, string>));
  next();
});
// … then the audit context: every record() in the handlers is attributed to this user and org.
app.use(
  auditContext({
    actor: (req) => actorOf((req as AuthedRequest).user),
    tenant: (req) => (req as AuthedRequest).user.orgId,
  }),
);

/** Adapt a framework-agnostic action to an Express handler. */
const handle =
  (action: (user: User, req: Request) => Result | Promise<Result>) =>
  (req: Request, res: Response) => {
    Promise.resolve(action((req as AuthedRequest).user, req)).then(
      (r) => res.status(r.status).json(r.body),
      (err: unknown) =>
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
    );
  };
const input = (req: Request) => (req.body ?? {}) as Record<string, string>;

app.get("/", (_req, res) => {
  res.type("html").send(renderDemoPage("/audit"));
});
app.get("/api/me", handle((user) => me(user)));
app.post("/api/members", handle((user, req) => inviteMember(audit, user, input(req))));
app.post(
  "/api/members/:id/role",
  handle((user, req) => changeRole(audit, user, String(req.params.id), input(req))),
);
app.post(
  "/api/invoices/:id/pay",
  handle((user, req) => payInvoice(audit, user, String(req.params.id), input(req))),
);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () =>
  console.log(`Express on http://localhost:${port} (app at /, audit panel at /audit)`),
);
