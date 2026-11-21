/**
 * One-command demo: a seeded audit-log playground — the panel, the customer
 * portal, two SIEM streams and a live trickle of new events — on one port.
 *
 *   bun run demo            # → http://localhost:7790
 *   PORT=3000 bun run demo
 *   DEMO_LIVE=0 bun run demo  # no live trickle (stable screenshots)
 *
 * What you get (see `scripts/seed-demo.ts` for the story):
 *
 * - four customer tenants (acme, globex, initech, umbrella) with six weeks of
 *   realistic history, recorded with the clock moved through time, a typed
 *   action catalog (descriptions + groups), erasures and exports;
 * - an Ed25519 signer with daily checkpoints (JWKS at `/api/integrity/keys`);
 * - retention (365 days; 30 for umbrella, whose chain is pruned to a signed base);
 * - two streams: `siem` (HTTP NDJSON to a local receiver that rejects its first
 *   3 requests, then catches up from the beginning) and `globex-splunk` (a
 *   customer's Splunk HEC with a revoked token: every batch is refused, so it
 *   keeps a growing lag and a recorded error);
 * - portal tokens: `/demo/portal?tenant=acme` mints one and opens the portal.
 *
 * Everything is in memory: Ctrl-C and it is gone. The SPA needs the UI bundle
 * (`bun run build:ui`); without it the panel's API still works and the page
 * says how to build it.
 *
 * @module
 */

import { createAuditCore } from "../src/core.ts";
import { createPortalToken } from "../src/portal.ts";
import { ed25519Signer, generateSigningKeyPair } from "../src/integrity.ts";
import { createFetchHandler } from "../src/server/create-fetch-handler.ts";
import { httpSink } from "../src/sinks/http.ts";
import { splunkSink } from "../src/sinks/splunk.ts";
import type { AuditActor } from "../src/schema.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";
import { DEMO_ACTIONS, DEMO_CORE_OPTIONS, DEMO_TENANTS, demoClock, seedDemo } from "./seed-demo.ts";

const PORT = Number(process.env.PORT ?? 7790);
const BASE = `http://localhost:${PORT}`;
// Fixed so links printed in docs keep working across restarts. Never do this in production.
const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "demo-portal-secret-change-me";
const SIEM_FAIL_FIRST = 3;

// ── The receivers the streams push to (stand-ins for a SIEM and a customer's Splunk) ──

let siemRequests = 0;
let siemItems = 0;
const receivers = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/siem") {
      const lines = (await request.text()).split("\n").filter(Boolean);
      if (++siemRequests <= SIEM_FAIL_FIRST) {
        console.log(`[siem receiver] 503 on purpose (${siemRequests}/${SIEM_FAIL_FIRST})`);
        return new Response("ingest temporarily unavailable", { status: 503 });
      }
      siemItems += lines.length;
      return new Response(null, { status: 202 });
    }
    if (path === "/services/collector/event") {
      // A customer rotated their HEC token and never updated it: every batch is refused.
      await request.arrayBuffer();
      return Response.json({ text: "Invalid token", code: 4 }, { status: 403 });
    }
    return new Response("not found", { status: 404 });
  },
});

// ── The core: seeded with the clock moved through six weeks of history ──

const clock = demoClock();
const key = await generateSigningKeyPair();
const core = createAuditCore({
  storage: createMemoryStorage(),
  actions: DEMO_ACTIONS,
  signer: await ed25519Signer(key.privateJwk),
  now: clock.now,
  ...DEMO_CORE_OPTIONS,
});

console.log("Seeding six weeks of audit history …");
const started = performance.now();
const summary = await seedDemo(core, clock);
const total = Object.values(summary.events).reduce((a, b) => a + b, 0);
console.log(
  `Seeded ${total} events across ${DEMO_TENANTS.length} tenants in ${Math.round(performance.now() - started)} ms ` +
    `(${summary.exports} exports, ${summary.erasures} erasures, ` +
    `${Object.values(summary.checkpoints).reduce((a, b) => a + b, 0)} signed checkpoints, ` +
    `pruned ${Object.entries(summary.pruned)
      .map(([t, n]) => `${n} from ${t}`)
      .join(", ")}).`,
);

// ── The panel: admin UI + API + portal + streams, over the seeded core ──

const panel = createFetchHandler({
  core,
  title: "Audit Log Demo",
  portal: { secret: PORTAL_SECRET },
  streams: [
    {
      name: "siem",
      sink: httpSink({ url: `${receivers.url.origin}/siem`, format: "ndjson" }),
      startFrom: "beginning",
      batchSize: 200,
    },
    {
      name: "globex-splunk",
      sink: splunkSink({ url: receivers.url.origin, token: "revoked-hec-token", index: "audit" }),
      tenants: ["globex"],
      startFrom: "beginning",
    },
  ],
  streamRunner: { interval: "2s", maxBackoff: "2m", onError: () => {} },
});

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    // Stands in for the host app's own route: after its auth, mint a token for the
    // signed-in customer's org and open the portal with it (`?token=` is the SPA's
    // standalone-embed affordance; React hosts pass `token` to <AuditPortal> instead).
    if (url.pathname === "/demo/portal") {
      const tenant = url.searchParams.get("tenant") ?? "acme";
      if (!DEMO_TENANTS.some((t) => t.key === tenant)) {
        return new Response(`unknown tenant "${tenant}"`, { status: 404 });
      }
      const token = await createPortalToken(PORTAL_SECRET, tenant, { expiresIn: "12h" });
      return Response.redirect(`${BASE}/?token=${encodeURIComponent(token)}`, 302);
    }
    if (url.pathname === "/healthcheck") return new Response("ok");
    return panel.fetch(request);
  },
});

// ── Live trickle: a sign-in every few seconds, so lag and "recent" move ──

let live: ReturnType<typeof setInterval> | undefined;
if (process.env.DEMO_LIVE !== "0") {
  live = setInterval(async () => {
    const tenant = DEMO_TENANTS[Math.floor(Math.random() * DEMO_TENANTS.length)]!.key;
    const recent = await core.query({ tenant, actions: ["user.login"], limit: 20 });
    const previous = recent.items[Math.floor(Math.random() * recent.items.length)];
    if (!previous) return;
    await core.record({
      tenant,
      action: "user.login",
      actor: previous.actor as AuditActor,
      context: { ...previous.context, requestId: `req_${crypto.randomUUID().slice(0, 16)}` },
      metadata: { method: previous.metadata.method as "sso", mfa: true },
      description: `${previous.actor.name ?? previous.actor.id} signed in`,
    });
  }, 8_000);
}

const acmeToken = await createPortalToken(PORTAL_SECRET, "acme", { expiresIn: "12h" });
console.log(`
Audit Log Demo running — press Ctrl-C to stop.

  Admin panel        ${BASE}/
  Customer portal    ${BASE}/demo/portal?tenant=acme   (also globex | initech | umbrella)
  Portal token       ${acmeToken.slice(0, 32)}…   (acme, 12h — full URL below)
                     ${BASE}/?token=${acmeToken}
  API                ${BASE}/api/tenants · ${BASE}/api/openapi.json
  Public JWKS        ${BASE}/api/integrity/keys   (signing key ${key.keyId})
  Streams            siem → ${receivers.url.origin}/siem (rejects the first ${SIEM_FAIL_FIRST} batches)
                     globex-splunk → a revoked HEC token (keeps failing, lag grows)
  Retention          365d; umbrella 30d (pruned prefix, anchored by a base checkpoint)

  Try:  curl -s ${BASE}/api/tenants/acme/verify | jq
        curl -s '${BASE}/api/tenants/acme/events?actions=member.*&limit=5' | jq '.items[].description'
        curl -s ${BASE}/api/tenants/globex/export?format=bundle > globex.jsonl && bunx xtandard-audit verify --bundle globex.jsonl
`);

const shutdown = async () => {
  if (live) clearInterval(live);
  await panel.close();
  server.stop(true);
  receivers.stop(true);
  console.log(`\n[siem receiver] accepted ${siemItems} items in total.`);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
