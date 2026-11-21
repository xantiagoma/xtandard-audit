/**
 * One-command runner for the portal-embed example: boots a throwaway in-memory
 * panel on :3702 (seeded with a few weeks of one customer's activity and a
 * signing key, so "Verify" has checkpoints to check), exposes a demo
 * `/api/audit-portal-token` mint route, then starts the Vite host app.
 *
 *   bun run start          # → http://localhost:5191 (vite) + panel on :3702
 *   # or from the repo root: bun run examples:portal-embed
 *
 * Ctrl-C stops both. Nothing is persisted.
 */

import { createPortalToken, ed25519Signer, generateSigningKeyPair } from "@xtandard/audit";
import { auditPanel } from "@xtandard/audit/bun";
import { createMemoryStorage } from "@xtandard/audit/storage/memory";

const PANEL_PORT = 3702; // must match the proxy target in vite.config.ts + PANEL_URL in src/App.tsx
const VITE_PORT = process.env.PORT ?? "5191";
const TENANT = "acme";

// The portal secret NEVER reaches a browser — it only mints and verifies
// tokens server-side. Fixed here so the demo is reproducible.
const PORTAL_SECRET = "portal-embed-demo-secret-change-me";

const panel = auditPanel({
  storage: createMemoryStorage(),
  title: "Acme Cloud — audit",
  signer: await ed25519Signer((await generateSigningKeyPair()).privateJwk),
  // A valid audpt_… bearer becomes a portal principal confined to its token's
  // tenant; /config then reports `portal: true` and the embed renders the
  // reduced, tenant-pinned portal chrome.
  portal: { secret: PORTAL_SECRET },
  // The host app (Vite origin) calls the panel API cross-origin with a Bearer
  // token — no cookies, so no `credentials` needed.
  cors: {
    origin: (origin) =>
      origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"),
  },
});

// Seed the tenant the token is scoped to: three weeks of a small team's activity.
const team = [
  { id: "usr_ada", name: "Ada Lovelace", email: "ada@acme.com" },
  { id: "usr_grace", name: "Grace Hopper", email: "grace@acme.com" },
  { id: "usr_alan", name: "Alan Turing", email: "alan@acme.com" },
];
const now = Date.now();
const inputs = [];
for (let day = 21; day >= 0; day--) {
  for (const [i, person] of team.entries()) {
    const at = new Date(now - day * 86_400_000 - (9 - i) * 3_600_000).toISOString();
    inputs.push({
      tenant: TENANT,
      action: "user.login",
      occurredAt: at,
      actor: person,
      context: { ip: `203.0.113.${10 + i}`, location: "New York, US" },
      metadata: { method: "sso", mfa: true },
      description: `${person.name} signed in with SSO`,
    });
  }
  if (day % 5 === 0) {
    inputs.push({
      tenant: TENANT,
      action: "invoice.paid",
      occurredAt: new Date(now - day * 86_400_000).toISOString(),
      actor: { id: "system:billing", type: "system", name: "Billing" },
      targets: [{ type: "invoice", id: `in_${day}`, name: `INV-2026-00${40 + day}` }],
      metadata: { amount: 49_00, currency: "USD" },
      description: `INV-2026-00${40 + day} paid`,
    });
  }
}
inputs.push({
  tenant: TENANT,
  action: "member.role_changed",
  actor: team[0]!,
  targets: [{ type: "user", id: "usr_alan", name: "Alan Turing" }],
  metadata: { from: "member", to: "admin" },
  description: "Ada Lovelace changed Alan Turing's role from member to admin",
});
await panel.core.recordMany(inputs);
await panel.core.checkpoint(TENANT); // sign the head so "Verify" reports a signed chain
// Another customer's events — the portal token must never show them.
await panel.core.record({ tenant: "globex", action: "user.login", actor: { id: "usr_hank" } });

const server = Bun.serve({
  port: PANEL_PORT,
  fetch: async (request) => {
    const url = new URL(request.url);
    // Simulates the HOST APP's backend: a session-guarded route that mints a
    // token for the signed-in user's organization. The Vite dev server proxies
    // it here so it looks same-origin to the frontend.
    if (url.pathname === "/api/audit-portal-token" && request.method === "POST") {
      const token = await createPortalToken(PORTAL_SECRET, TENANT, { expiresIn: "1h" });
      return Response.json({ token, tenant: TENANT, expiresIn: "1h" });
    }
    return panel.fetch(request);
  },
});

console.log(
  `\n▶ portal-embed host app → http://localhost:${VITE_PORT} (audit panel on :${PANEL_PORT})\n`,
);
const vite = Bun.spawn(["bunx", "vite", "--port", VITE_PORT], {
  stdout: "inherit",
  stderr: "inherit",
});

const shutdown = () => {
  vite.kill();
  server.stop(true);
  void panel.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await vite.exited;
shutdown();
