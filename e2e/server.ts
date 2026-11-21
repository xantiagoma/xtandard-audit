/**
 * The Playwright e2e server: the real panel (`createFetchHandler`) over memory
 * storage, booted by playwright.config.ts's webServer. Run under Bun:
 *
 *   bun e2e/server.ts
 *
 * Seeds a multi-tenant log ("acme" with enough events to page, "globex"), a
 * code-defined action catalog plus one panel-defined entry, a signed
 * checkpoint (Ed25519), and two streams: a healthy collector and a sink that
 * always fails (the Streams view's error + retry path).
 *
 * Test-only routes (outside the panel):
 *   GET /healthcheck                          → 200 (webServer readiness probe)
 *   GET /e2e/portal-token?tenant=X&exclude=a  → { token } a freshly minted portal token
 *                                               (`exclude` → the token's excludeActions filter)
 *   GET /e2e/embed?mode=&theme=&host=         → a host page mounting the built React embed
 *                                               (mode: dashboard | portal;
 *                                               host: class | attr | none → dark class / data-theme)
 */

import {
  createFetchHandler,
  createPortalToken,
  defineActions,
  ed25519Signer,
  generateSigningKeyPair,
} from "../src/index.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { callbackSink } from "../src/streams.ts";
import { collectingSink } from "../src/testing.ts";

const PORT = Number(process.env.PORT ?? 3311);
const PORTAL_SECRET = "e2e-portal-secret";

const actions = defineActions({
  "user.login": { description: "A user signed in.", group: "Access" },
  "invoice.paid": {
    description: "An invoice was paid in full.",
    group: "Billing",
    targets: ["invoice"],
  },
  "invoice.voided": {
    description: "An invoice was voided.",
    group: "Billing",
    targets: ["invoice"],
  },
  "member.role_changed": {
    description: "A member's role changed.",
    group: "Members",
    targets: ["user"],
  },
  "document.viewed": { description: "A document was opened.", group: "Documents" },
  "support.impersonated": { description: "Support signed in as a user.", group: "Support" },
});

const { privateJwk } = await generateSigningKeyPair();
const signer = await ed25519Signer(privateJwk, { keyId: "e2e-key-1" });

const panel = createFetchHandler({
  storage: createMemoryStorage(),
  title: "@xtandard/audit e2e",
  signer,
  actions,
  portal: { secret: PORTAL_SECRET },
  streams: [
    { name: "archive", sink: collectingSink("archive"), startFrom: "beginning" },
    {
      name: "siem",
      sink: callbackSink(() => {
        throw new Error("SIEM endpoint unreachable (connection refused)");
      }, "http"),
      startFrom: "beginning",
    },
  ],
  // The failing sink is intentional: keep its retries out of the server log.
  streamRunner: { interval: "250ms", maxBackoff: "2s", onError: () => {} },
  maintenance: false,
});
const { core } = panel;

// ── Seed ────────────────────────────────────────────────────────────────────
const alice = { id: "user_alice", name: "Alice Admin", email: "alice@acme.test" };
const bob = { id: "user_bob", name: "Bob Builder", email: "bob@acme.test" };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// 60 older filler events so the explorer has more than one page (50).
for (let i = 0; i < 60; i++) {
  await core.record({
    tenant: "acme",
    action: "document.viewed",
    occurredAt: minutesAgo(3000 + i),
    actor: bob,
    targets: [{ type: "document", id: `doc_${i}`, name: `Document ${i}` }],
    outcome: "success",
  });
}
await core.record({
  tenant: "acme",
  action: "user.login",
  occurredAt: minutesAgo(40),
  actor: alice,
  context: { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (e2e)", requestId: "req_login_1" },
  outcome: "success",
});
await core.record({
  tenant: "acme",
  action: "invoice.paid",
  occurredAt: minutesAgo(30),
  actor: alice,
  targets: [{ type: "invoice", id: "inv_1001", name: "INV-1001" }],
  metadata: { amount: 4200, currency: "USD" },
  outcome: "success",
  description: "Alice paid invoice INV-1001",
});
await core.record({
  tenant: "acme",
  action: "invoice.voided",
  occurredAt: minutesAgo(20),
  actor: bob,
  targets: [{ type: "invoice", id: "inv_1002", name: "INV-1002" }],
  metadata: { reason: "duplicate" },
  outcome: "failure",
});
await core.record({
  tenant: "acme",
  action: "member.role_changed",
  occurredAt: minutesAgo(10),
  actor: alice,
  targets: [{ type: "user", id: "user_bob", name: "Bob Builder" }],
  metadata: { from: "member", to: "admin" },
  context: { ip: "203.0.113.7", location: "Medellín, CO" },
  outcome: "success",
  description: "Alice changed Bob's role to admin",
});
await core.record({
  tenant: "acme",
  action: "support.impersonated",
  occurredAt: minutesAgo(5),
  actor: { id: "support_1", type: "support", name: "Acme Support" },
  targets: [{ type: "user", id: "user_alice" }],
  outcome: "success",
});
await core.checkpoint("acme");

for (const [i, action] of (["user.login", "invoice.paid", "invoice.paid"] as const).entries()) {
  await core.record({
    tenant: "globex",
    action,
    occurredAt: minutesAgo(15 - i),
    actor: { id: "user_carol", name: "Carol Globex" },
    ...(action === "invoice.paid"
      ? { targets: [{ type: "invoice", id: `gx_${i}` }], metadata: { amount: 100 * i } }
      : {}),
    outcome: "success",
  });
}

// A panel-defined catalog entry (editable in the UI, unlike the code ones).
await core.upsertAction({
  name: "report.exported",
  description: "A report was exported.",
  group: "Reports",
});

// ── Host page for the React embed (e2e/embed.spec.ts) ───────────────────────
// Host styles mimic a themed app: its own text/background per theme, so a
// panel that leaks or inherits the host's text color shows up as low contrast.
const EMBED_HOST_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>embed host</title>
    <link rel="stylesheet" href="/e2e/react.css" />
    <style>
      body { margin: 0; font-family: system-ui; background: #ffffff; color: #111111; }
      html.dark body, html[data-theme="dark"] body { background: #0b0b0c; color: #f4f4f5; }
    </style>
  </head>
  <body>
    <div id="host-root"></div>
    <script type="module" src="/e2e/embed.js"></script>
  </body>
</html>`;

let embedBundle: Promise<string> | undefined;
const buildEmbedHost = async (): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [new URL("./embed-host.tsx", import.meta.url).pathname],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "embed host bundle failed");
  return result.outputs[0]!.text();
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthcheck") return json({ ok: true });
    if (url.pathname === "/e2e/embed") {
      const markup =
        url.searchParams.get("host") === "attr"
          ? EMBED_HOST_HTML.replace('<html lang="en">', '<html lang="en" data-theme="dark">')
          : url.searchParams.get("host") === "class"
            ? EMBED_HOST_HTML.replace('<html lang="en">', '<html lang="en" class="dark">')
            : EMBED_HOST_HTML;
      return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/e2e/embed.js") {
      embedBundle ??= buildEmbedHost();
      return new Response(await embedBundle, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    if (url.pathname === "/e2e/react.css") {
      return new Response(Bun.file(new URL("../dist/react.css", import.meta.url)), {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }
    if (url.pathname === "/e2e/portal-token") {
      const tenant = url.searchParams.get("tenant") ?? "acme";
      const exclude = url.searchParams.getAll("exclude");
      const token = await createPortalToken(PORTAL_SECRET, tenant, {
        expiresIn: "1h",
        ...(exclude.length ? { filter: { excludeActions: exclude } } : {}),
      });
      return json({ token });
    }
    return panel.fetch(request);
  },
});

console.log(`e2e server listening on http://localhost:${PORT}`);
