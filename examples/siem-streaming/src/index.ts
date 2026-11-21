/**
 * Streaming the log to a SIEM, a customer's webhook, and a checkpoint witness.
 *
 *   bun run src/index.ts
 *
 * Three streams over one core (ADR 0008 — streams READ the log by per-tenant
 * cursors; nothing sits on the record path):
 *
 *   siem      httpSink → POST /ingest            every tenant, JSON batches
 *   customer  webhookSink → POST /webhook        tenant "acme" only, Standard Webhooks-signed,
 *                                                verified on arrival with @xtandard/webhooks/receiver
 *   witness   a callback sink keeping only the signed checkpoints (witness copies
 *             that live outside the database — what makes a later rewrite detectable)
 *
 * The receiver rejects its first 2 requests per route, so you watch the cursor
 * hold, the backoff (1s, 2s, …) and the catch-up; lag is printed as it drains.
 * At the end the witnessed checkpoints verify an export of the chain.
 */
import {
  callbackSink,
  createAuditCore,
  createStreamRunner,
  ed25519Signer,
  generateSigningKeyPair,
  parseBundle,
  verifyChain,
  exportEvents,
  type AuditCheckpoint,
} from "@xtandard/audit";
import { httpSink } from "@xtandard/audit/sinks/http";
import { webhookSink } from "@xtandard/audit/sinks/webhook";
import { createMemoryStorage } from "@xtandard/audit/storage/memory";
import { startReceiver } from "./receiver.ts";

const WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))}`;
const receiver = startReceiver({ failFirst: 2, webhookSecret: WEBHOOK_SECRET });
console.log(`Receiver on ${receiver.url} (fails the first 2 requests per route)\n`);

const signer = await ed25519Signer((await generateSigningKeyPair()).privateJwk);
const audit = createAuditCore({
  storage: createMemoryStorage(),
  signer,
  checkpoints: { every: 10 }, // sign the head every 10 events per tenant
});

const witnessed: AuditCheckpoint[] = [];
const runner = createStreamRunner(audit, {
  streams: [
    { name: "siem", sink: httpSink({ url: `${receiver.url}/ingest` }), batchSize: 25 },
    {
      name: "customer",
      sink: webhookSink({ url: `${receiver.url}/webhook`, secret: WEBHOOK_SECRET, mode: "batch" }),
      tenants: ["acme"],
      filter: { excludeActions: ["user.login"] }, // the customer only wants admin activity
    },
    {
      name: "witness",
      sink: callbackSink((batch) => {
        for (const item of batch.items)
          if (item.kind === "checkpoint") witnessed.push(item.checkpoint);
      }, "witness"),
    },
  ],
  interval: "500ms",
  maxBackoff: "4s",
  onError: (err, { stream, tenant }) =>
    console.log(
      `  ✗ ${stream}/${tenant}: ${err instanceof Error ? err.message : String(err)} → backing off`,
    ),
});

// Streams start "now" by default: only events recorded from here on are delivered.
runner.start();

// ── The app records while the streams run ─────────────────────────────────────
const people = [
  { id: "usr_ada", name: "Ada Lovelace" },
  { id: "usr_hank", name: "Hank Scorpio" },
];
const actions = ["user.login", "member.invited", "invoice.paid", "api_key.created", "user.login"];
for (let i = 0; i < 40; i++) {
  const tenant = i % 4 === 3 ? "globex" : "acme";
  await audit.record({
    tenant,
    action: actions[i % actions.length]!,
    actor: tenant === "acme" ? people[0]! : people[1]!,
    targets: [{ type: "user", id: `usr_${i}` }],
  });
  if (i % 10 === 9) {
    const status = await runner.status();
    const lag = status
      .map((s) => `${s.name}=${s.tenants.reduce((n, t) => n + t.lag, 0)}`)
      .join(" ");
    console.log(`→ recorded ${i + 1} events · lag ${lag}`);
  }
  await Bun.sleep(60);
}
await audit.settled();

// ── Wait for every stream to drain (backoff included) ──────────────────────────
const deadline = Date.now() + 30_000;
for (;;) {
  const status = await runner.status();
  const lag = status.reduce((n, s) => n + s.tenants.reduce((m, t) => m + t.lag, 0), 0);
  if (lag === 0) break;
  if (Date.now() > deadline) {
    console.error("streams did not drain in 30s:", JSON.stringify(status, null, 2));
    process.exit(1);
  }
  await Bun.sleep(250);
}
await runner.stop();

console.log(
  `\nDrained. Accepted by the SIEM: ${receiver.accepted.ingest.size} items; ` +
    `by the customer webhook: ${receiver.accepted.webhook.size} items; witnessed checkpoints: ${witnessed.length}.`,
);

// ── The witness at work: verify an export against checkpoints kept elsewhere ──
const stream = await exportEvents(audit, { tenant: "acme" }, { format: "bundle" });
const bundle = parseBundle(await new Response(stream).text());
const report = await verifyChain(bundle.events, {
  checkpoints: witnessed.filter((c) => c.tenant === "acme"), // NOT the bundle's own copies
  keys: [await signer.verificationKey()],
});
console.log(
  `acme export vs witnessed checkpoints: ${report.ok ? "VALID" : "INVALID"} — ` +
    `${report.checked} events, signed through #${report.signedThrough}`,
);
receiver.stop();
process.exit(report.ok ? 0 : 1);
