/**
 * Run a bundled example with a free port (no collisions if you run several).
 *
 *   bun run examples:hono      # or: elysia | express | bun | auth | portal-embed | …
 *
 * Server examples get a free PORT picked via get-port-please; script examples
 * (no server) just run. Each example is installed (`bun install`) on first use.
 * Examples link the package via `file:../..`, so build the repo once first:
 * `bun run build`.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPort } from "get-port-please";

interface ExampleConfig {
  dir: string;
  kind: "server" | "script";
  /** Command to run (in the example dir). */
  run: string[];
  /** Optional pre-step (e.g. start a database) run once before `run`. */
  seed?: string[];
  /** Preferred port for server examples; a nearby free one is used if taken. */
  preferredPort?: number;
  /** External requirement to surface before running. */
  note?: string;
}

const EXAMPLES: Record<string, ExampleConfig> = {
  hono: {
    dir: "examples/hono",
    kind: "server",
    run: ["bun", "run", "start"],
    preferredPort: 3000,
    note: "team-settings app at /, audit panel at /audit",
  },
  elysia: {
    dir: "examples/elysia",
    kind: "server",
    run: ["bun", "run", "start"],
    preferredPort: 3000,
    note: "team-settings app at /, audit panel at /audit (SQLite storage)",
  },
  express: {
    dir: "examples/express",
    kind: "server",
    run: ["bun", "run", "start"],
    preferredPort: 3000,
    note: "team-settings app at /, audit panel at /audit (mounted before express.json())",
  },
  bun: {
    dir: "examples/bun",
    kind: "server",
    run: ["bun", "run", "start"],
    preferredPort: 3000,
    note: "plain Bun.serve + withAuditContext; app at /, audit panel at /audit",
  },
  auth: {
    dir: "examples/auth",
    kind: "server",
    run: ["bun", "run", "start"],
    preferredPort: 3000,
    note: "auth/authz flexibility demo — set AUTH_DEMO=none|basic|delegated|roles (portal-token mint route in every mode)",
  },
  "portal-embed": {
    dir: "examples/portal-embed",
    kind: "server",
    run: ["bun", "run", "start"],
    preferredPort: 5191,
    note: "embedded <AuditPortal/> in a host app (vite) — boots a seeded panel on :3702 + mints a portal token",
  },
  "storage-drivers": {
    dir: "examples/storage-drivers",
    kind: "script",
    run: ["bun", "run", "start"],
    note: "memory, file, sqlite, PGlite and libsql always run; set DATABASE_URL / REDIS_URL / MONGO_URL to add those",
  },
  postgres: {
    dir: "examples/postgres",
    kind: "script",
    seed: ["sh", "-c", "bun run db:up && bun run db:push"],
    run: ["bun", "run", "start"],
    note: "docker compose Postgres on :54329 + drizzle-kit push (PGLITE=1 bun run start in the example skips Docker)",
  },
  "siem-streaming": {
    dir: "examples/siem-streaming",
    kind: "script",
    run: ["bun", "run", "start"],
    note: "http + Standard Webhooks + checkpoint-witness streams; the receiver fails the first 2 requests per route",
  },
  "drizzle-audit-bridge": {
    dir: "examples/drizzle-audit-bridge",
    kind: "script",
    run: ["bun", "run", "start"],
    note: "drizzle-audit row changes on PGlite → createDrizzleAuditStorage → the audit core",
  },
  "verify-export": {
    dir: "examples/verify-export",
    kind: "script",
    run: ["bun", "run", "start"],
    note: "signed bundles verified offline with @xtandard/audit/verify and `xtandard-audit verify` (exit 0 / 2 / 1)",
  },
};

const name = process.argv[2];
const cfg = name ? EXAMPLES[name] : undefined;
if (!cfg) {
  console.error(`Unknown example "${name ?? ""}". Available: ${Object.keys(EXAMPLES).join(", ")}`);
  process.exit(1);
}

if (!existsSync("dist")) {
  console.error("dist/ is missing — build the package first: bun run build");
  process.exit(1);
}

async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const cleanup = () => proc.kill();
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  return proc.exited;
}

if (cfg.note) console.log(`i  ${name}: ${cfg.note}`);

// Install on first use (examples link the package via file:../..).
if (!existsSync(join(cfg.dir, "node_modules"))) {
  console.log(`Installing ${name} dependencies …`);
  const code = await sh(["bun", "install"], cfg.dir);
  if (code !== 0) process.exit(code);
}

if (cfg.seed) {
  const code = await sh(cfg.seed, cfg.dir);
  if (code !== 0) process.exit(code);
}

const env: Record<string, string> = {};
if (cfg.kind === "server") {
  const preferred = cfg.preferredPort ?? 3000;
  const port = await getPort({ port: preferred, portRange: [preferred, preferred + 200] });
  env.PORT = String(port);
  console.log(`>  ${name} → http://localhost:${port}`);
}

process.exit(await sh(cfg.run, cfg.dir, env));
