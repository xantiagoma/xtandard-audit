/**
 * `xtandard-audit` CLI. Operates on the same storage your app/panel uses
 * (configured via `STORAGE_DRIVER` and friends, mirroring the standalone app),
 * so it slots into shell, CI, cron and auditor workflows.
 *
 * Commands: `serve` (panel + streams + retention, no Docker), `record`,
 * `query`, `export`, `verify` (a bundle offline, or a tenant in storage),
 * `prune`, `checkpoint`, `keygen`, `tenants`, `actions`.
 *
 * Storage drivers and sinks are loaded lazily by **dynamic import of their
 * subpath entries** (`entry-storage-<driver>`, `entry-sinks-<kind>`) next to
 * this module, so the CLI only pulls the peer dependency of the driver you
 * pick — and a driver that is not part of a build is a clear runtime error,
 * not a bundling failure.
 *
 * @module
 */

import type { AuthProvider } from "./auth/contract.ts";
import type { AuthorizationProvider } from "./authorization/contract.ts";
import { createAuditCore, type AuditCore, type RetentionOptions } from "./core.ts";
import { durationToMs } from "./duration.ts";
import {
  EXPORT_CONTENT_TYPES,
  exportEvents,
  parseBundle,
  verifyBundle,
  type ExportFormat,
} from "./export.ts";
import {
  ed25519Signer,
  generateSigningKeyPair,
  hmacSigner,
  hmacVerificationKey,
  keysFromJwks,
  type AuditSigner,
  type AuditVerificationKey,
  type VerifyReport,
} from "./integrity.ts";
import type { AuditDuration, AuditEventInput, AuditQuery, JsonObject } from "./schema.ts";
import type { ActionMap } from "./standard-schema.ts";
import type { AuditStorage } from "./storage/contract.ts";
import type { AuditSink, StreamDefinition } from "./streams.ts";

/** The storage drivers the CLI knows how to configure from env. */
export const CLI_DRIVERS = [
  "memory",
  "file",
  "redis",
  "postgres",
  "mongodb",
  "sqlite",
  "libsql",
] as const;
type Driver = (typeof CLI_DRIVERS)[number];

const env = (key: string, fallback = ""): string => process.env[key] ?? fallback;

const isTruthy = (value: string): boolean => value === "1" || value.toLowerCase() === "true";
const isFalsy = (value: string): boolean => value === "0" || value.toLowerCase() === "false";

const warn = (message: string): void => {
  process.stderr.write(`[xtandard/audit] ${message}\n`);
};

/** Raised when a lazily-imported subpath entry is not part of this build. */
export class MissingModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingModuleError";
  }
}

/**
 * Import a sibling entry module by name: `./<entry>.mjs` in the built package
 * (`dist/`), `./<entry>.ts` when running from source. The specifier is computed
 * so bundlers leave it alone. Errors raised *inside* a found module (e.g. a
 * missing peer dependency) propagate unchanged.
 */
export async function importEntry(entry: string): Promise<Record<string, unknown>> {
  for (const ext of [".mjs", ".ts"]) {
    const specifier = `./${entry}${ext}`;
    try {
      return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code;
      const notFound =
        code === "ERR_MODULE_NOT_FOUND" ||
        /Cannot find (module|package)|Failed to load url|failed to resolve|does not exist/i.test(
          message,
        );
      if (notFound && message.includes(entry)) continue;
      throw err;
    }
  }
  throw new MissingModuleError(`Module "${entry}" is not available in this build`);
}

/** Find a factory export by name, else the single export matching `pattern`. */
function pickFactory<T>(
  mod: Record<string, unknown>,
  name: string,
  pattern: RegExp,
): ((...args: unknown[]) => T) | null {
  if (typeof mod[name] === "function") return mod[name] as (...args: unknown[]) => T;
  const candidates = Object.entries(mod).filter(
    ([k, v]) => typeof v === "function" && pattern.test(k),
  );
  return candidates.length === 1 ? (candidates[0]![1] as (...args: unknown[]) => T) : null;
}

/** The storage driver named by `STORAGE_DRIVER` (CLI default: `file`). */
function driverFromEnv(): Driver {
  const raw = env("STORAGE_DRIVER", "file") || "file";
  if (!(CLI_DRIVERS as readonly string[]).includes(raw)) {
    throw new Error(`Unknown STORAGE_DRIVER "${raw}" (expected ${CLI_DRIVERS.join(" | ")})`);
  }
  return raw as Driver;
}

/** Driver → [entry module, factory export, options from env]. */
function driverSpec(driver: Driver): [string, string, Record<string, unknown>] {
  switch (driver) {
    case "memory":
      return ["entry-storage-memory", "createMemoryStorage", {}];
    case "redis":
      return [
        "entry-storage-redis",
        "createRedisStorage",
        {
          url: env("REDIS_URL", "redis://localhost:6379"),
          prefix: env("STORAGE_PREFIX", "xtandard:audit"),
        },
      ];
    case "postgres":
      return [
        "entry-storage-postgres",
        "createPostgresStorage",
        {
          connectionString:
            env("DATABASE_URL") || env("POSTGRES_URL", "postgres://localhost:5432/postgres"),
          table: env("STORAGE_PG_TABLE", "xtandard_audit"),
        },
      ];
    case "mongodb":
      return [
        "entry-storage-mongodb",
        "createMongoStorage",
        {
          url: env("MONGO_URL", "mongodb://localhost:27017"),
          dbName: env("MONGO_DB", "xtandard_audit"),
          collectionName: env("STORAGE_MONGO_COLLECTION", "audit"),
        },
      ];
    case "sqlite":
      // Requires running the CLI under Bun (`bunx xtandard-audit …`).
      return [
        "entry-storage-sqlite",
        "createSqliteStorage",
        { path: env("STORAGE_SQLITE_PATH", "./.audit/audit.sqlite") },
      ];
    case "libsql": {
      const authToken = env("LIBSQL_AUTH_TOKEN");
      return [
        "entry-storage-libsql",
        "createLibsqlStorage",
        {
          url: env("LIBSQL_URL", "file:./.audit/audit.db"),
          ...(authToken ? { authToken } : {}),
        },
      ];
    }
    case "file":
      return [
        "entry-storage-file",
        "createFileStorage",
        { dir: env("STORAGE_FILE_DIR", "./.audit") },
      ];
  }
}

/** Build the storage from env, importing the driver's subpath lazily. */
export async function buildStorage(): Promise<AuditStorage> {
  const driver = driverFromEnv();
  const [entry, factoryName, options] = driverSpec(driver);
  let mod: Record<string, unknown>;
  try {
    mod = await importEntry(entry);
  } catch (err) {
    if (err instanceof MissingModuleError) {
      throw new Error(
        `Storage driver "${driver}" is not available (missing @xtandard/audit/storage/${driver})`,
      );
    }
    throw err;
  }
  const factory = pickFactory<AuditStorage>(mod, factoryName, /^create\w*Storage$/);
  if (!factory) throw new Error(`@xtandard/audit/storage/${driver} exports no ${factoryName}`);
  return factory(options);
}

/**
 * A human-readable, log-safe description of where storage persists data — for
 * the `serve` startup banner. Connection-string drivers print only the driver
 * name (never the URL, which may carry credentials).
 */
async function describeStorage(): Promise<string> {
  const { resolve } = await import("node:path");
  const driver = driverFromEnv();
  switch (driver) {
    case "file":
      return `file → ${resolve(env("STORAGE_FILE_DIR", "./.audit"))}`;
    case "sqlite":
      return `sqlite → ${resolve(env("STORAGE_SQLITE_PATH", "./.audit/audit.sqlite"))}`;
    case "memory":
      return "memory (ephemeral — not persisted)";
    default:
      return driver;
  }
}

/** Parse a duration env like `"365d"`, warning and ignoring malformed values. */
function parseDurationEnv(name: string): AuditDuration | undefined {
  const raw = env(name);
  if (!raw) return undefined;
  try {
    durationToMs(raw as AuditDuration); // validate eagerly
    return raw as AuditDuration;
  } catch {
    warn(`Ignoring ${name}="${raw}" — expected <number><unit> with unit ms|s|m|h|d (e.g. 365d).`);
    return undefined;
  }
}

/** Retention from env: `RETENTION_MAX_AGE` / `RETENTION_KEEP_LAST`. */
export function retentionFromEnv(): RetentionOptions | undefined {
  const keepRaw = env("RETENTION_KEEP_LAST");
  const keepLast = keepRaw && /^\d+$/.test(keepRaw) ? Number(keepRaw) : undefined;
  if (keepRaw && keepLast === undefined) {
    warn(`Ignoring RETENTION_KEEP_LAST="${keepRaw}" — expected a number.`);
  }
  const maxAge = parseDurationEnv("RETENTION_MAX_AGE");
  if (keepLast === undefined && !maxAge) return undefined;
  return {
    ...(keepLast !== undefined ? { keepLast } : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

/** Checkpoint signer from env: `AUDIT_SIGNING_KEY` (Ed25519 private JWK JSON) or `AUDIT_HMAC_SECRET`. */
export async function signerFromEnv(): Promise<AuditSigner | undefined> {
  const jwk = env("AUDIT_SIGNING_KEY");
  if (jwk) {
    let parsed: JsonWebKey;
    try {
      parsed = JSON.parse(jwk) as JsonWebKey;
    } catch {
      throw new Error(
        "AUDIT_SIGNING_KEY must be a private JWK as JSON (see `xtandard-audit keygen`)",
      );
    }
    return ed25519Signer(parsed);
  }
  const secret = env("AUDIT_HMAC_SECRET");
  return secret ? hmacSigner(secret) : undefined;
}

/** A stream declared in `AUDIT_STREAMS` (JSON array). */
interface StreamEnv {
  name: string;
  /** Sink kind: loads `@xtandard/audit/sinks/<sink>` and calls its `<kind>Sink(options)` factory. */
  sink: string;
  options?: Record<string, unknown>;
  tenants?: string[];
  filter?: StreamDefinition["filter"];
  batchSize?: number;
  startFrom?: "beginning" | "now";
  checkpoints?: boolean;
}

const camel = (kind: string) => kind.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Streams from `AUDIT_STREAMS` (JSON array of {@link StreamEnv}). */
export async function streamsFromEnv(): Promise<StreamDefinition[]> {
  const raw = env("AUDIT_STREAMS");
  if (!raw) return [];
  let specs: StreamEnv[];
  try {
    specs = JSON.parse(raw) as StreamEnv[];
    if (!Array.isArray(specs)) throw new Error("not an array");
  } catch {
    throw new Error('AUDIT_STREAMS must be a JSON array of { "name", "sink", "options"? , … }');
  }
  const out: StreamDefinition[] = [];
  for (const spec of specs) {
    let mod: Record<string, unknown>;
    try {
      mod = await importEntry(`entry-sinks-${spec.sink}`);
    } catch (err) {
      if (err instanceof MissingModuleError) {
        throw new Error(
          `Sink "${spec.sink}" (stream "${spec.name}") is not available (missing @xtandard/audit/sinks/${spec.sink})`,
        );
      }
      throw err;
    }
    const factory = pickFactory<AuditSink>(mod, `${camel(spec.sink)}Sink`, /Sink$/);
    if (!factory) throw new Error(`@xtandard/audit/sinks/${spec.sink} exports no sink factory`);
    out.push({
      name: spec.name,
      sink: await factory(spec.options ?? {}),
      ...(spec.tenants ? { tenants: spec.tenants } : {}),
      ...(spec.filter ? { filter: spec.filter } : {}),
      ...(spec.batchSize ? { batchSize: spec.batchSize } : {}),
      ...(spec.startFrom ? { startFrom: spec.startFrom } : {}),
      ...(spec.checkpoints !== undefined ? { checkpoints: spec.checkpoints } : {}),
    });
  }
  return out;
}

/** Build the auth + authorization providers from env (mirrors the standalone app). */
async function buildAuth(): Promise<{ auth: AuthProvider; authorization: AuthorizationProvider }> {
  const mode = env("AUTH_MODE", "none");
  if (mode === "basic") {
    const [{ basicAuth }, { rolesAuthorization }] = await Promise.all([
      import("./auth/basic.ts"),
      import("./authorization/roles.ts"),
    ]);
    const passwordHash = env("AUTH_PASSWORD_HASH");
    const password = env("AUTH_PASSWORD");
    if (!passwordHash && !password) {
      warn("AUTH_MODE=basic but neither AUTH_PASSWORD_HASH nor AUTH_PASSWORD is set.");
    }
    return {
      auth: basicAuth({
        users: [
          {
            username: env("AUTH_USERNAME", "admin"),
            ...(passwordHash ? { passwordHash } : {}),
            ...(password ? { password } : {}),
            roles: [env("AUTH_ROLE", "admin")],
          },
        ],
      }),
      authorization: rolesAuthorization({}),
    };
  }
  const [{ noAuth }, { noAuthorization }] = await Promise.all([
    import("./auth/none.ts"),
    import("./authorization/none.ts"),
  ]);
  return { auth: noAuth(), authorization: noAuthorization() };
}

type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Serve a web-standard fetch handler under whatever runtime the CLI runs on:
 * `Bun.serve` under `bunx`, a `node:http` bridge under `npx`/Node (streaming
 * response bodies, so exports are never buffered). Resolves once listening.
 */
async function startServer(port: number, fetch: FetchHandler): Promise<void> {
  const bun = (globalThis as { Bun?: { serve: (options: unknown) => unknown } }).Bun;
  if (bun) {
    bun.serve({ port, fetch });
    return;
  }
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const method = req.method ?? "GET";
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        const host = req.headers.host ?? `localhost:${port}`;
        const url = `http://${host}${req.url ?? "/"}`;
        const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0;
        const request = new Request(url, {
          method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        });
        const response = await fetch(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (response.body) {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            res.write(chunk);
          }
        }
        res.end();
      } catch (err) {
        res.statusCode = 500;
        res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
}

type Flags = Record<string, string | boolean>;

/** Minimal flag/value argv parser: `--key value`, `--key=value` and `--flag`. */
export function parseArgs(argv: string[]): { _: string[]; flags: Flags } {
  const _: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(a);
  }
  return { _, flags };
}

const str = (flags: Flags, key: string): string | undefined =>
  typeof flags[key] === "string" ? (flags[key] as string) : undefined;

/** The query model from flags (same names as the HTTP query parameters). */
export function queryFromFlags(flags: Flags): AuditQuery {
  const q: AuditQuery = {};
  const list = (key: string) =>
    str(flags, key)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const actions = list("actions");
  if (actions?.length) q.actions = actions;
  const exclude = list("excludeActions");
  if (exclude?.length) q.excludeActions = exclude;
  for (const k of [
    "tenant",
    "actorId",
    "actorType",
    "targetType",
    "targetId",
    "from",
    "to",
    "search",
    "cursor",
  ] as const) {
    const v = str(flags, k);
    if (v) q[k] = v;
  }
  const outcome = str(flags, "outcome");
  if (outcome === "success" || outcome === "failure") q.outcome = outcome;
  else if (outcome) throw new Error(`Invalid --outcome "${outcome}" (success | failure)`);
  const order = str(flags, "order");
  if (order === "asc" || order === "desc") q.order = order;
  else if (order) throw new Error(`Invalid --order "${order}" (asc | desc)`);
  const limit = str(flags, "limit");
  if (limit) q.limit = Number(limit);
  return q;
}

/** A core over the env-configured storage (no runner, no timers). */
async function makeCore(): Promise<AuditCore<ActionMap>> {
  const [storage, signer] = await Promise.all([buildStorage(), signerFromEnv()]);
  const retention = retentionFromEnv();
  return createAuditCore({
    storage,
    ...(signer ? { signer } : {}),
    ...(retention ? { retention } : {}),
  });
}

/** Read this package's version from the nearest package.json (dist or src). */
async function pkgVersion(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The `verify` exit code: `0` valid and anchored (genesis or a verified
 * checkpoint) with every event covered by a verified checkpoint, `2` valid
 * but the tail (or the start) is not anchored by a signature, `1` invalid.
 */
export function verifyExitCode(report: VerifyReport): 0 | 1 | 2 {
  if (!report.ok) return 1;
  if (report.checked === 0) return 0;
  const anchored = report.anchor === "genesis" || report.anchor === "checkpoint";
  const signed = report.signedThrough !== null && report.signedThrough >= (report.toSeq ?? 0);
  return anchored && signed ? 0 : 2;
}

function describeReport(report: VerifyReport): string {
  const lines = [
    `${report.ok ? "VALID" : "INVALID"}: ${report.checked} event(s)` +
      (report.fromSeq !== null ? ` (seq ${report.fromSeq}..${report.toSeq})` : "") +
      (report.tenant ? ` of tenant "${report.tenant}"` : ""),
    `anchor: ${report.anchor}; checkpoints verified: ${report.checkpointsVerified}; signed through: ${report.signedThrough ?? "—"}`,
  ];
  if (report.erased.length)
    lines.push(`erased: ${report.erased.length} event(s) with erased sections`);
  for (const issue of report.issues) {
    lines.push(
      `  ✗ ${issue.kind}${issue.seq !== undefined ? ` @${issue.seq}` : ""}: ${issue.message}`,
    );
  }
  const code = verifyExitCode(report);
  if (code === 2) {
    lines.push(
      report.signedThrough === null
        ? "warning: no verified checkpoint covers these events (unsigned)"
        : `warning: events after seq ${report.signedThrough} are not covered by a verified checkpoint`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Keys from `--jwks <file|url>`. */
async function loadJwks(source: string): Promise<AuditVerificationKey[]> {
  let text: string;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`GET ${source} → ${res.status}`);
    text = await res.text();
  } else {
    const { readFile } = await import("node:fs/promises");
    text = await readFile(source, "utf8");
  }
  return keysFromJwks(JSON.parse(text) as { keys: JsonWebKey[] });
}

function helpText(version: string): string {
  return `xtandard-audit v${version} — self-hosted, tamper-evident audit-log control plane

Usage:
  xtandard-audit <command> [options]     # the binary, after: npm i -g @xtandard/audit
  npx @xtandard/audit <command>          # without installing (or: bunx @xtandard/audit …)

Commands:
  serve [--port <n>]            Run the panel + API + streams + retention (no Docker).
  record --tenant <t> --action <a> --actor <id> [--actor-type <type>]
         [--targets type:id,…] [--metadata '<json>'] [--outcome success|failure]
         [--description <text>]
  record --event '<json>'       Record one event (ingest from shell/CI). Prints it.
  query [--tenant <t>] [--actions a,b] [--excludeActions …] [--actorId …] [--actorType …]
        [--targetType …] [--targetId …] [--outcome …] [--from …] [--to …] [--search …]
        [--order asc|desc] [--limit n] [--cursor c] [--json]
                                Search events (flags = the HTTP query parameters).
  export --tenant <t> [--format csv|json|jsonl|bundle] [--out <file>] [query flags]
                                Stream an export to stdout (or --out).
  verify --bundle <file.jsonl> [--jwks <file|url>] [--hmac-secret <s>]
  verify --tenant <t> [--fromSeq n] [--toSeq n]
                                Verify an export bundle offline (or a tenant's chain in
                                storage). Exit 0 = valid and anchored by genesis or a
                                verified checkpoint; 2 = valid but the tail is not covered
                                by a verified checkpoint (unsigned); 1 = invalid.
  prune [--tenant <t>]          Apply the retention policy (RETENTION_*).
  checkpoint --tenant <t>       Sign a tenant's chain head (needs AUDIT_SIGNING_KEY or
                                AUDIT_HMAC_SECRET).
  keygen                        Print a new Ed25519 private JWK (→ AUDIT_SIGNING_KEY) and
                                its public JWKS.
  tenants                       List tenants with their head seq and retained count.
  actions                       List the action catalog.

Global options:
  -h, --help                    Show this help.
  -v, --version                 Print the version.

Environment variables
  Storage:
    STORAGE_DRIVER              memory | file | redis | postgres | mongodb | sqlite | libsql
                                (CLI default: file · Docker default: memory)
    STORAGE_FILE_DIR            ./.audit                                 (driver: file)
    REDIS_URL, STORAGE_PREFIX   redis://localhost:6379, xtandard:audit   (driver: redis)
    DATABASE_URL | POSTGRES_URL, STORAGE_PG_TABLE                        (driver: postgres)
    MONGO_URL, MONGO_DB, STORAGE_MONGO_COLLECTION                        (driver: mongodb)
    STORAGE_SQLITE_PATH         ./.audit/audit.sqlite                    (driver: sqlite, Bun only)
    LIBSQL_URL, LIBSQL_AUTH_TOKEN                                        (driver: libsql)

  Integrity:
    AUDIT_SIGNING_KEY           Ed25519 private JWK (JSON) — signs checkpoints; the public
                                key is served at {BASE_PATH}/api/integrity/keys.
    AUDIT_HMAC_SECRET           HMAC checkpoint secret (when no AUDIT_SIGNING_KEY).

  Retention (kept if EITHER rule keeps it; never past an undelivered stream cursor):
    RETENTION_MAX_AGE           e.g. 365d (ms|s|m|h|d)
    RETENTION_KEEP_LAST         Keep at most the N most recent events per tenant.
    MAINTENANCE_INTERVAL  1h    How often \`serve\` prunes; 0|false disables.

  Server (\`serve\` / standalone):
    PORT            3000        Port to listen on (or --port).
    BASE_PATH       ""          URL prefix, e.g. "/audit".
    TITLE                       Navbar wordmark.
    LOGO_URL                    Logo image URL.
    READONLY        1|true      Block all mutating operations.
    AUTH_MODE       none|basic  Authentication mode (default none).
    AUTH_USERNAME   admin       Username for basic auth.
    AUTH_PASSWORD_HASH          scrypt hash (preferred; see docs/AUTH.md).
    AUTH_PASSWORD               Plaintext password (dev only).
    AUTH_ROLE       admin       Role of the basic-auth user (admin | auditor | viewer).
    PORTAL_SECRET               Enables portal-token access (audpt_… bearer tokens).

  Streams (\`serve\` / standalone):
    AUDIT_STREAMS               JSON array: [{ "name": "siem", "sink": "http",
                                "options": { "url": "https://…" }, "startFrom": "now" }]
    STREAM_RUNNER   1           0|false: show stream status but do not run them here.

Examples:
  # Quick local panel (file storage, no auth):
  npx @xtandard/audit serve --port 3004

  # Signed checkpoints:
  export AUDIT_SIGNING_KEY="$(xtandard-audit keygen | head -1)"

  # Record from CI:
  xtandard-audit record --tenant acme --action deploy.finished --actor ci \\
    --metadata '{"sha":"abc123"}'

  # Export a verifiable bundle and verify it against the published keys:
  xtandard-audit export --tenant acme --format bundle --out acme.jsonl
  xtandard-audit verify --bundle acme.jsonl --jwks https://app.example.com/audit/api/integrity/keys

Docs: https://github.com/xantiagoma/xtandard-audit
`;
}

/** Entry point. Returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  const { _, flags } = parseArgs(argv);
  const command = _[0];

  // `--version` (bare) / `-v` / `version` → print version.
  if (flags.version === true || argv.includes("-v") || command === "version") {
    process.stdout.write(`${await pkgVersion()}\n`);
    return 0;
  }

  const wantsHelp = Boolean(flags.help) || argv.includes("-h") || command === "help";
  if (!command || wantsHelp) {
    process.stdout.write(helpText(await pkgVersion()));
    // Explicit help request → success; bare invocation with no command → usage error.
    return wantsHelp ? 0 : 1;
  }

  try {
    switch (command) {
      case "keygen": {
        const { privateJwk, publicJwk } = await generateSigningKeyPair();
        process.stdout.write(
          `${JSON.stringify(privateJwk)}\n${JSON.stringify({ keys: [{ ...publicJwk, alg: "Ed25519", use: "sig" }] })}\n`,
        );
        process.stderr.write(
          "Line 1: private JWK — set it as AUDIT_SIGNING_KEY (keep it secret).\n" +
            "Line 2: public JWKS — publish it so auditors can verify checkpoints.\n",
        );
        return 0;
      }
      case "tenants": {
        const core = await makeCore();
        const tenants = await core.listTenants();
        if (tenants.length === 0) process.stdout.write("No tenants.\n");
        for (const t of tenants) {
          process.stdout.write(
            `${t.key}  seq ${t.head.seq}  ${t.count ?? 0} event(s)` +
              (t.head.baseSeq && t.head.baseSeq > 1 ? `  (pruned before ${t.head.baseSeq})` : "") +
              "\n",
          );
        }
        return 0;
      }
      case "actions": {
        const core = await makeCore();
        const actions = await core.listActions();
        if (actions.length === 0) process.stdout.write("No actions in the catalog.\n");
        for (const a of actions) {
          process.stdout.write(
            `${a.name}${a.group ? `  [${a.group}]` : ""}${a.deprecated ? "  (deprecated)" : ""}` +
              `${a.description ? `  ${a.description}` : ""}\n`,
          );
        }
        return 0;
      }
      case "record": {
        let input: Partial<AuditEventInput>;
        const eventJson = str(flags, "event");
        if (eventJson) {
          try {
            input = JSON.parse(eventJson) as Partial<AuditEventInput>;
          } catch {
            process.stderr.write("Invalid --event JSON.\n");
            return 1;
          }
        } else {
          const tenant = str(flags, "tenant");
          const action = str(flags, "action");
          const actorId = str(flags, "actor");
          if (!tenant || !action || !actorId) {
            process.stderr.write(
              "Usage: xtandard-audit record --tenant <t> --action <a> --actor <id> [--metadata '<json>'] [--targets type:id,…]\n" +
                "   or: xtandard-audit record --event '<json>'\n",
            );
            return 1;
          }
          let metadata: JsonObject | undefined;
          const raw = str(flags, "metadata");
          if (raw) {
            try {
              metadata = JSON.parse(raw) as JsonObject;
            } catch {
              process.stderr.write("Invalid --metadata JSON.\n");
              return 1;
            }
          }
          const targets = str(flags, "targets")
            ?.split(",")
            .filter(Boolean)
            .map((t) => {
              const i = t.indexOf(":");
              return i > 0 ? { type: t.slice(0, i), id: t.slice(i + 1) } : { type: t, id: t };
            });
          const actorType = str(flags, "actor-type");
          const outcome = str(flags, "outcome");
          const description = str(flags, "description");
          input = {
            tenant,
            action,
            actor: { id: actorId, ...(actorType ? { type: actorType } : {}) },
            ...(targets?.length ? { targets } : {}),
            ...(metadata ? { metadata } : {}),
            ...(outcome ? { outcome: outcome as AuditEventInput["outcome"] } : {}),
            ...(description ? { description } : {}),
          };
        }
        const core = await makeCore();
        const event = await core.record(input as AuditEventInput);
        process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
        return 0;
      }
      case "query": {
        const core = await makeCore();
        const page = await core.query(queryFromFlags(flags));
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
          return 0;
        }
        if (page.items.length === 0) process.stdout.write("No events.\n");
        for (const e of page.items) {
          process.stdout.write(
            `${e.occurredAt}  ${e.tenant}#${e.seq}  ${e.action}  by ${e.actor.id}` +
              (e.targets.length
                ? `  → ${e.targets.map((t) => `${t.type}:${t.id}`).join(",")}`
                : "") +
              (e.outcome === "failure" ? "  (failure)" : "") +
              "\n",
          );
        }
        if (page.pageInfo.hasNextPage) {
          process.stdout.write(`… more: --cursor ${page.pageInfo.endCursor}\n`);
        }
        return 0;
      }
      case "export": {
        const tenant = str(flags, "tenant");
        const format = (str(flags, "format") ?? "jsonl") as ExportFormat;
        if (!tenant) {
          process.stderr.write(
            "Usage: xtandard-audit export --tenant <t> [--format csv|json|jsonl|bundle] [--out <file>]\n",
          );
          return 1;
        }
        if (!(format in EXPORT_CONTENT_TYPES)) {
          process.stderr.write(`Invalid --format "${format}" (csv | json | jsonl | bundle).\n`);
          return 1;
        }
        const core = await makeCore();
        const query = { ...queryFromFlags(flags), tenant };
        delete query.limit;
        delete query.cursor;
        const stream = await exportEvents(core, query, {
          format,
          actor: { id: "cli", name: "xtandard-audit CLI" },
        });
        const out = str(flags, "out");
        if (out) {
          const { createWriteStream } = await import("node:fs");
          const file = createWriteStream(out);
          for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
            file.write(chunk);
          await new Promise<void>((resolve, reject) => {
            file.end((err?: Error | null) => (err ? reject(err) : resolve()));
          });
          process.stderr.write(`Exported ${format} → ${out}\n`);
        } else {
          for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
            process.stdout.write(chunk);
          }
        }
        return 0;
      }
      case "verify": {
        const bundlePath = str(flags, "bundle");
        const tenant = str(flags, "tenant");
        if (!bundlePath && !tenant) {
          process.stderr.write(
            "Usage: xtandard-audit verify --bundle <file.jsonl> [--jwks <file|url>] [--hmac-secret <s>]\n" +
              "   or: xtandard-audit verify --tenant <t> [--fromSeq n] [--toSeq n]\n",
          );
          return 1;
        }
        let report: VerifyReport;
        if (bundlePath) {
          const { readFile } = await import("node:fs/promises");
          const text = await readFile(bundlePath, "utf8");
          const keys: AuditVerificationKey[] = [];
          const jwks = str(flags, "jwks");
          if (jwks) {
            keys.push(...(await loadJwks(jwks)));
          } else {
            // Without --jwks, trust the bundle's own JWKS (and say so).
            const embedded = parseBundle(text).jwks;
            if (embedded?.keys.length) {
              keys.push(...(await keysFromJwks(embedded as { keys: JsonWebKey[] })));
              process.stderr.write(
                "note: checkpoint signatures verified with the keys embedded in the bundle — pass --jwks <operator's published keys> to not trust the file for them.\n",
              );
            }
          }
          const hmac = str(flags, "hmac-secret") ?? env("AUDIT_HMAC_SECRET");
          if (hmac) keys.push(hmacVerificationKey(hmac));
          report = await verifyBundle(text, keys.length ? { keys } : {});
        } else {
          const core = await makeCore();
          const fromSeq = str(flags, "fromSeq");
          const toSeq = str(flags, "toSeq");
          report = await core.verify(tenant!, {
            ...(fromSeq ? { fromSeq: Number(fromSeq) } : {}),
            ...(toSeq ? { toSeq: Number(toSeq) } : {}),
          });
        }
        if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else process.stdout.write(describeReport(report));
        return verifyExitCode(report);
      }
      case "prune": {
        const core = await makeCore();
        if (!core.options.retention) {
          process.stderr.write(
            "No retention policy: set RETENTION_MAX_AGE and/or RETENTION_KEEP_LAST.\n",
          );
          return 1;
        }
        const tenant = str(flags, "tenant");
        const actor = { actor: { id: "cli", name: "xtandard-audit CLI" } };
        const results = tenant ? [await core.pruneTenant(tenant, actor)] : await core.prune(actor);
        for (const r of results) {
          process.stdout.write(
            `${r.tenant}: pruned ${r.pruned}, first retained seq ${r.baseSeq}\n`,
          );
        }
        return 0;
      }
      case "checkpoint": {
        const tenant = str(flags, "tenant");
        if (!tenant) {
          process.stderr.write("Usage: xtandard-audit checkpoint --tenant <t>\n");
          return 1;
        }
        const core = await makeCore();
        const cp = await core.checkpoint(tenant, {
          actor: { id: "cli", name: "xtandard-audit CLI" },
        });
        process.stdout.write(`${JSON.stringify(cp, null, 2)}\n`);
        return 0;
      }
      case "serve": {
        const port = Number(str(flags, "port") || env("PORT", "3000"));
        const basePath = env("BASE_PATH", "");
        const title = env("TITLE", "@xtandard/audit");
        const logoUrl = env("LOGO_URL");
        const readonly = isTruthy(env("READONLY"));
        const authMode = env("AUTH_MODE", "none");
        const portalSecret = env("PORTAL_SECRET");
        const maintenanceRaw = env("MAINTENANCE_INTERVAL");

        const { createFetchHandler } = await import("./server/create-fetch-handler.ts");
        const [storage, signer, streams, { auth, authorization }] = await Promise.all([
          buildStorage(),
          signerFromEnv(),
          streamsFromEnv(),
          buildAuth(),
        ]);

        if (authMode === "none") {
          warn("AUTH_MODE=none — do NOT expose this publicly without authentication.");
        }

        const retention = retentionFromEnv();
        const panel = createFetchHandler({
          storage,
          basePath,
          title,
          ...(logoUrl ? { logoUrl } : {}),
          readonly,
          auth,
          authorization,
          ...(signer ? { signer } : {}),
          ...(portalSecret ? { portal: { secret: portalSecret } } : {}),
          ...(retention ? { retention } : {}),
          ...(streams.length ? { streams } : {}),
          ...(isFalsy(env("STREAM_RUNNER", "1")) ? { streamRunner: false as const } : {}),
          maintenance:
            maintenanceRaw && isFalsy(maintenanceRaw)
              ? false
              : { interval: (parseDurationEnv("MAINTENANCE_INTERVAL") ?? "1h") as AuditDuration },
        });

        const normalizedBase =
          basePath && basePath !== "/"
            ? basePath.startsWith("/")
              ? basePath
              : `/${basePath}`
            : "";

        const handler: FetchHandler = (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/healthcheck" || url.pathname === `${normalizedBase}/healthcheck`) {
            return new Response(JSON.stringify({ status: "ok", title }), {
              headers: { "content-type": "application/json" },
            });
          }
          return panel.fetch(request);
        };

        process.stdout.write(`[xtandard/audit] storage: ${await describeStorage()}\n`);
        process.stdout.write(
          `[xtandard/audit] signer: ${signer ? `${signer.alg} (${signer.keyId})` : "none (no checkpoints)"}\n`,
        );
        process.stdout.write(
          `[xtandard/audit] streams: ${
            streams.length
              ? `${streams.map((s) => s.name).join(", ")}${isFalsy(env("STREAM_RUNNER", "1")) ? " (not running here)" : ""}`
              : "none"
          }\n`,
        );

        await startServer(port, handler);
        process.stdout.write(
          `[xtandard/audit] listening on http://localhost:${port}${normalizedBase || "/"}\n`,
        );
        // The server owns the process now; never resolve so the bin doesn't exit.
        return await new Promise<number>(() => {});
      }
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${helpText(await pkgVersion())}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// `bun src/cli.ts <command>` (contributors); the published bin calls `run` itself.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  void run(process.argv.slice(2)).then((code) => process.exit(code));
}
