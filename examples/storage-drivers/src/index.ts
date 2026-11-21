/**
 * One contract, every backend.
 *
 *   bun run src/index.ts
 *
 * `AuditStorage` is a four-method KV contract plus an optional native
 * event-log capability (indexed SQL / Mongo queries). Every adapter below
 * satisfies it, so any of them can hold the whole log. This script proves it by
 * running the SAME scenario against each backend and printing the same table:
 *
 *   record 60 events in 2 tenants → query (families, actor, target, outcome,
 *   search, time range, keyset pages) → checkpoint → verify the chain.
 *
 * Always run (no server): memory, file, sqlite (`bun:sqlite`), PGlite-backed
 * postgres, and libSQL on a `file:` URL (when `@libsql/client` is installed —
 * it is an optionalDependency here). Network backends join in when their env
 * URL is set (install the peer first):
 *
 *   DATABASE_URL=postgres://localhost/db      bun add pg
 *   REDIS_URL=redis://localhost:6379          bun add redis
 *   MONGO_URL=mongodb://localhost:27017       bun add mongodb
 */
import {
  createAuditCore,
  ed25519Signer,
  generateSigningKeyPair,
  hasEventLog,
  newId,
  type AuditEventInput,
  type AuditStorage,
} from "@xtandard/audit";

/** Unique per-run namespace so repeated runs never collide in shared stores. */
const RUN = `run${Date.now().toString(36)}`;
const signer = await ed25519Signer((await generateSigningKeyPair()).privateJwk);

// ── One fixed scenario: the same inputs (ids included) for every backend ───────
const people = [
  { id: "usr_ada", name: "Ada Lovelace", email: "ada@acme.com" },
  { id: "usr_grace", name: "Grace Hopper", email: "grace@acme.com" },
  { id: "usr_hank", name: "Hank Scorpio", email: "hank@globex.de" },
];
const start = Date.parse("2026-10-01T09:00:00Z");
const inputs: AuditEventInput[] = Array.from({ length: 60 }, (_, i) => {
  const tenant = i % 3 === 2 ? "globex" : "acme";
  const actor = tenant === "globex" ? people[2]! : people[i % 2]!;
  const kind = i % 5;
  const occurredAt = new Date(start + i * 3_600_000);
  const base = { id: newId("evt", occurredAt.getTime()), tenant, actor, occurredAt };
  if (kind === 0) {
    return {
      ...base,
      action: "invoice.paid",
      targets: [{ type: "invoice", id: `inv_${i}`, name: `INV-${1000 + i}` }],
      metadata: { amount: 4900 + i, currency: "USD" },
    };
  }
  if (kind === 1) {
    return {
      ...base,
      action: "invoice.refunded",
      outcome: "failure" as const,
      targets: [{ type: "invoice", id: `inv_${i - 1}` }],
      metadata: { reason: "duplicate charge" },
      description: `Refund for INV-${999 + i} failed`,
    };
  }
  if (kind === 2) {
    return {
      ...base,
      action: "member.role_changed",
      targets: [{ type: "user", id: "usr_alan", name: "Alan Turing" }],
      metadata: { from: "member", to: "admin" },
    };
  }
  return { ...base, action: kind === 3 ? "user.login" : "api_key.created" };
});

/** The same queries, rendered to comparable strings. */
async function exercise(storage: AuditStorage): Promise<string[]> {
  const audit = createAuditCore({ storage, signer, checkpoints: false, selfAudit: false });
  await audit.recordMany(inputs);
  const ids = async (q: Parameters<typeof audit.query>[0]) =>
    (await audit.query(q)).items.map((e) => e.id.slice(-4)).join(" ");
  const count = async (q: Parameters<typeof audit.query>[0]) =>
    (await audit.query({ ...q, limit: 500 })).items.length;
  const page1 = await audit.query({ tenant: "acme", limit: 7 });
  const page2 = await audit.query({ tenant: "acme", limit: 7, cursor: page1.pageInfo.endCursor! });
  await audit.checkpoint("acme");
  const report = await audit.verify("acme");
  return [
    `${await audit.count("acme")}+${await audit.count("globex")}`,
    String(await count({ actions: ["invoice.*"] })),
    String(await count({ tenant: "acme", actorId: "usr_grace" })),
    String(await count({ targetType: "user", targetId: "usr_alan" })),
    String(await count({ outcome: "failure" })),
    String(await count({ search: "refund" })),
    String(await count({ from: "2026-10-02T00:00:00Z", to: "2026-10-03T00:00:00Z" })),
    `${await ids({ tenant: "acme", limit: 3, order: "asc" })} | ${page2.items[0]!.id.slice(-4)}`,
    `${report.ok ? "ok" : "BROKEN"} ${report.checked} signed→${report.signedThrough}`,
    hasEventLog(storage) ? "native" : "kv fallback",
  ];
}

const HEADER = [
  "events",
  "invoice.*",
  "by grace",
  "→ alan",
  "failures",
  '"refund"',
  "Oct 2",
  "first 3 (asc) | page 2",
  "verify",
  "log",
];
const rows: [string, string[]][] = [];
async function run(name: string, make: () => AuditStorage | Promise<AuditStorage>) {
  const storage = await make();
  try {
    rows.push([name, await exercise(storage)]);
  } finally {
    await (storage as { close?: () => unknown }).close?.();
  }
}
const skipped: string[] = [];

// ── No server needed ─────────────────────────────────────────────────────────
await run("memory", async () =>
  (await import("@xtandard/audit/storage/memory")).createMemoryStorage(),
);
await run("file", async () =>
  (await import("@xtandard/audit/storage/file")).createFileStorage({ dir: `./.audit/${RUN}` }),
);
await run("sqlite", async () => {
  await Bun.$`mkdir -p .audit`.quiet();
  return (await import("@xtandard/audit/storage/sqlite")).createSqliteStorage({
    path: `./.audit/${RUN}.sqlite`,
  });
});
await run("pglite", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { createPostgresStorage } = await import("@xtandard/audit/storage/postgres");
  return createPostgresStorage({ client: new PGlite() }); // in-process Postgres (WASM)
});
try {
  const libsqlPeer = "@libsql/client"; // optional: probe it without making it a hard import
  await import(libsqlPeer);
  await run("libsql", async () =>
    (await import("@xtandard/audit/storage/libsql")).createLibsqlStorage({
      url: `file:./.audit/${RUN}.libsql.db`,
    }),
  );
} catch {
  skipped.push("libsql      (bun add @libsql/client)");
}

// ── Network backends, when configured ────────────────────────────────────────
if (process.env.DATABASE_URL) {
  await run("postgres", async () =>
    (await import("@xtandard/audit/storage/postgres")).createPostgresStorage({
      connectionString: process.env.DATABASE_URL,
      table: `xtandard_audit_${RUN}`,
    }),
  );
} else skipped.push("postgres    (set DATABASE_URL)");
if (process.env.REDIS_URL) {
  await run("redis", async () =>
    (await import("@xtandard/audit/storage/redis")).createRedisStorage({
      url: process.env.REDIS_URL,
      prefix: `xtandard:audit:${RUN}`,
    }),
  );
} else skipped.push("redis       (set REDIS_URL)");
if (process.env.MONGO_URL) {
  await run("mongodb", async () =>
    (await import("@xtandard/audit/storage/mongodb")).createMongoStorage({
      url: process.env.MONGO_URL,
      collectionName: `audit_${RUN}`,
    }),
  );
} else skipped.push("mongodb     (set MONGO_URL)");

// ── The table ────────────────────────────────────────────────────────────────
const widths = HEADER.map((h, i) => Math.max(h.length, ...rows.map(([, r]) => r[i]!.length)));
const line = (name: string, cells: string[]) =>
  `${name.padEnd(9)} ${cells.map((c, i) => c.padEnd(widths[i]!)).join("  ")}`;
console.log("One contract, every backend — the same scenario, the same answers:\n");
console.log(line("", HEADER));
for (const [name, cells] of rows) console.log(line(name, cells));
for (const s of skipped) console.log(`  -- skipped ${s}`);

// Every column except the last (native vs KV-fallback event log) must agree.
const answers = new Set(rows.map(([, r]) => r.slice(0, -1).join("|")));
if (answers.size !== 1) {
  console.error("\nBackends disagree — that is a bug, please report it.");
  process.exit(1);
}
console.log(`\nIdentical results on ${rows.length} backends — that is the whole point.`);
process.exit(0);
