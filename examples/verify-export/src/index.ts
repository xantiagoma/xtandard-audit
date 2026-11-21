/**
 * Export a verifiable bundle and check it offline — the way your customer's
 * auditor would, with nothing but the file (and, ideally, your public keys).
 *
 *   bun run src/index.ts       # needs the CLI: `bun install` here links it (build the repo first)
 *
 * 1. Record a tenant's history with an Ed25519 signer; sign the head.
 * 2. Export bundles (events + checkpoints + JWKS in one JSONL file):
 *    - `acme.jsonl`     — every event covered by a signed checkpoint
 *    - `globex.jsonl`   — valid, but the newest events were recorded after the
 *                         last checkpoint (an unsigned tail)
 *    - `tampered.jsonl` — acme's bundle with one invoice amount edited
 * 3. Verify each with `@xtandard/audit/verify` (zero-dependency, Web Crypto) …
 * 4. … and with `xtandard-audit verify --bundle` — exit codes for CI/auditors:
 *    0 valid and signed through the end · 2 valid but the tail is unsigned · 1 invalid.
 */
import { createAuditCore, ed25519Signer, exportEvents, generateSigningKeyPair } from "@xtandard/audit";
import { createMemoryStorage } from "@xtandard/audit/storage/memory";
import { verifyBundle } from "@xtandard/audit/verify";

const OUT = "./.audit";
await Bun.$`mkdir -p ${OUT}`.quiet();

// ── 1. A signed log ───────────────────────────────────────────────────────────
const { privateJwk } = await generateSigningKeyPair(); // `xtandard-audit keygen` in real life
const audit = createAuditCore({
  storage: createMemoryStorage(),
  signer: await ed25519Signer(privateJwk),
  checkpoints: false, // sign explicitly below, to control what the bundles cover
});
const ada = { id: "usr_ada", name: "Ada Lovelace", email: "ada@acme.com" };
for (let i = 1; i <= 12; i++) {
  await audit.record({
    tenant: "acme",
    action: i % 3 === 0 ? "invoice.paid" : "user.login",
    actor: ada,
    ...(i % 3 === 0
      ? {
          targets: [{ type: "invoice", id: `inv_${i}`, name: `INV-2026-00${40 + i}` }],
          metadata: { amount: 4900, currency: "USD" },
        }
      : {}),
  });
}
for (let i = 1; i <= 5; i++) {
  await audit.record({ tenant: "globex", action: "user.login", actor: { id: "usr_hank" } });
}
await audit.checkpoint("globex"); // signs #1–#5 …
for (let i = 1; i <= 3; i++) {
  await audit.record({ tenant: "globex", action: "api_key.created", actor: { id: "usr_hank" } });
} // … but not #6–#8

// The public keys auditors should trust — publish them (the panel serves /api/integrity/keys).
await Bun.write(`${OUT}/jwks.json`, JSON.stringify(await audit.jwks(), null, 2));

// ── 2. Export bundles ─────────────────────────────────────────────────────────
async function exportBundle(tenant: string, signHead: boolean): Promise<string> {
  // The export records itself (`audit_log.exported`) before streaming, so the
  // bundle includes its own self-audit event. The stream is lazy: signing the
  // head now, before reading it, makes the checkpoint cover that event too.
  const stream = await exportEvents(audit, { tenant }, { format: "bundle", actor: ada });
  if (signHead) await audit.checkpoint(tenant);
  const text = await new Response(stream).text();
  await Bun.write(`${OUT}/${tenant}.jsonl`, text);
  return text;
}
const acme = await exportBundle("acme", true);
await exportBundle("globex", false);

// The tamper: change one invoice's amount and keep everything else — including the hashes.
const tampered = acme.replace('"amount":4900', '"amount":49'); // the first invoice only
await Bun.write(`${OUT}/tampered.jsonl`, tampered);
console.log(`Wrote ${OUT}/acme.jsonl, ${OUT}/globex.jsonl, ${OUT}/tampered.jsonl and ${OUT}/jwks.json\n`);

// ── 3. Verify in code: @xtandard/audit/verify ────────────────────────────────
console.log("@xtandard/audit/verify:");
for (const file of ["acme", "globex", "tampered"]) {
  const report = await verifyBundle(await Bun.file(`${OUT}/${file}.jsonl`).text());
  const issue = report.issues[0];
  console.log(
    `  ${`${file}.jsonl`.padEnd(15)} ${report.ok ? "VALID  " : "INVALID"} ${report.checked} events, ` +
      `anchor ${report.anchor}, signed through ${report.signedThrough ?? "—"} of ${report.toSeq}` +
      (issue ? ` — ${issue.kind} at #${issue.seq}: ${issue.message}` : ""),
  );
}

// ── 4. Verify with the CLI: exit codes ────────────────────────────────────────
console.log("\nxtandard-audit verify --bundle <file> --jwks jwks.json:");
for (const file of ["acme", "globex", "tampered"]) {
  const proc = Bun.spawn(
    ["bunx", "xtandard-audit", "verify", "--bundle", `${OUT}/${file}.jsonl`, "--jwks", `${OUT}/jwks.json`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  console.log(`\n$ xtandard-audit verify --bundle ${file}.jsonl --jwks jwks.json   → exit ${code}`);
  console.log((stdout + stderr).trim().replace(/^/gm, "  "));
}
console.log("\nExit codes: 0 valid and signed through the end · 2 valid, unsigned tail · 1 invalid.");
