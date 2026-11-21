import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importEntry,
  parseArgs,
  queryFromFlags,
  retentionFromEnv,
  run,
  signerFromEnv,
  streamsFromEnv,
  verifyExitCode,
} from "../src/cli.ts";
import { createAuditCore } from "../src/core.ts";
import { exportEvents } from "../src/export.ts";
import { generateSigningKeyPair, ed25519Signer, type VerifyReport } from "../src/integrity.ts";
import { createMemoryStorage as realMemoryStorage } from "../src/storage/memory.ts";

// Every `run([...])` builds a fresh core from env; with STORAGE_DRIVER=memory
// that would be a fresh, empty store each time. Share one store across calls
// (reset per test) so commands see each other's writes, like a real database.
const shared = vi.hoisted(() => ({ storage: null as unknown }));
vi.mock("../src/entry-storage-memory.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/entry-storage-memory.ts")>();
  return {
    ...mod,
    createMemoryStorage: () => (shared.storage ??= mod.createMemoryStorage()),
  };
});

let dir: string;
let out: string[];
let err: string[];

const ENV = [
  "STORAGE_DRIVER",
  "STORAGE_FILE_DIR",
  "RETENTION_KEEP_LAST",
  "RETENTION_MAX_AGE",
  "AUDIT_SIGNING_KEY",
  "AUDIT_HMAC_SECRET",
  "AUDIT_STREAMS",
  "AUTH_MODE",
  "PORT",
];
const saved: Record<string, string | undefined> = {};
const text = (s: unknown) =>
  typeof s === "string" ? s : new TextDecoder().decode(s as Uint8Array);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-cli-"));
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  process.env.STORAGE_DRIVER = "memory";
  shared.storage = null;
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(text(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(text(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const stdout = () => out.join("");
const stderr = () => err.join("");

describe("cli basics", () => {
  test("help exits 0 with --help, 1 with no command", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(stdout()).toContain("xtandard-audit v");
    expect(stdout()).toContain("AUDIT_SIGNING_KEY");
    expect(await run([])).toBe(1);
    expect(await run(["help"])).toBe(0);
  });

  test("version", async () => {
    expect(await run(["--version"])).toBe(0);
    expect(await run(["-v"])).toBe(0);
    expect(stdout()).toMatch(/\d+\.\d+\.\d+/);
  });

  test("unknown commands and drivers fail", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(stderr()).toContain("Unknown command: frobnicate");
    process.env.STORAGE_DRIVER = "floppy";
    expect(await run(["tenants"])).toBe(1);
    expect(stderr()).toContain('Unknown STORAGE_DRIVER "floppy"');
  });

  test("parseArgs handles --k v, --k=v and boolean flags", () => {
    expect(parseArgs(["query", "--tenant", "acme", "--limit=5", "--json"])).toEqual({
      _: ["query"],
      flags: { tenant: "acme", limit: "5", json: true },
    });
  });

  test("queryFromFlags maps the HTTP query parameter names", () => {
    expect(
      queryFromFlags({
        tenant: "acme",
        actions: "a.*,b",
        excludeActions: "c",
        actorId: "u",
        outcome: "failure",
        order: "asc",
        limit: "10",
      }),
    ).toEqual({
      tenant: "acme",
      actions: ["a.*", "b"],
      excludeActions: ["c"],
      actorId: "u",
      outcome: "failure",
      order: "asc",
      limit: 10,
    });
    expect(() => queryFromFlags({ outcome: "meh" })).toThrow(/outcome/);
    expect(() => queryFromFlags({ order: "up" })).toThrow(/order/);
  });
});

describe("env contract", () => {
  test("retention", () => {
    expect(retentionFromEnv()).toBeUndefined();
    process.env.RETENTION_MAX_AGE = "365d";
    process.env.RETENTION_KEEP_LAST = "100";
    expect(retentionFromEnv()).toEqual({ maxAge: "365d", keepLast: 100 });
    process.env.RETENTION_MAX_AGE = "forever";
    process.env.RETENTION_KEEP_LAST = "lots";
    expect(retentionFromEnv()).toBeUndefined();
    expect(stderr()).toContain("Ignoring RETENTION_MAX_AGE");
    expect(stderr()).toContain("Ignoring RETENTION_KEEP_LAST");
  });

  test("signer: Ed25519 JWK, HMAC secret, or none", async () => {
    expect(await signerFromEnv()).toBeUndefined();
    process.env.AUDIT_HMAC_SECRET = "s";
    expect((await signerFromEnv())!.alg).toBe("HS256");
    const { privateJwk } = await generateSigningKeyPair();
    process.env.AUDIT_SIGNING_KEY = JSON.stringify(privateJwk);
    expect((await signerFromEnv())!.alg).toBe("Ed25519");
    process.env.AUDIT_SIGNING_KEY = "not json";
    await expect(signerFromEnv()).rejects.toThrow(/private JWK/);
  });

  test("streams: empty, malformed, unknown sink", async () => {
    expect(await streamsFromEnv()).toEqual([]);
    process.env.AUDIT_STREAMS = "{}";
    await expect(streamsFromEnv()).rejects.toThrow(/JSON array/);
    process.env.AUDIT_STREAMS = JSON.stringify([{ name: "s", sink: "no-such-sink" }]);
    await expect(streamsFromEnv()).rejects.toThrow(/missing @xtandard\/audit\/sinks\/no-such-sink/);
  });

  test("importEntry: missing modules are a MissingModuleError", async () => {
    await expect(importEntry("entry-does-not-exist")).rejects.toThrow(/not available/);
    expect(Object.keys(await importEntry("entry-hooks-log")).length).toBeGreaterThan(0);
  });
});

describe("commands", () => {
  test("record (flags and --event), query, tenants", async () => {
    expect(
      await run([
        "record",
        "--tenant",
        "acme",
        "--action",
        "invoice.paid",
        "--actor",
        "ci",
        "--actor-type",
        "service",
        "--targets",
        "invoice:inv_1,user:u1",
        "--metadata",
        '{"amount":42}',
        "--outcome",
        "success",
        "--description",
        "Paid",
      ]),
    ).toBe(0);
    const printed = JSON.parse(stdout()) as { seq: number; targets: unknown[]; actor: unknown };
    expect(printed.seq).toBe(1);
    expect(printed.targets).toEqual([
      { type: "invoice", id: "inv_1" },
      { type: "user", id: "u1" },
    ]);
    expect(printed.actor).toEqual({ id: "ci", type: "service" });
    expect(
      await run([
        "record",
        "--event",
        JSON.stringify({ tenant: "acme", action: "user.login", actor: { id: "u1" } }),
      ]),
    ).toBe(0);

    out = [];
    expect(await run(["query", "--tenant", "acme", "--limit", "1"])).toBe(0);
    expect(stdout()).toContain("acme#2  user.login  by u1");
    expect(stdout()).toContain("… more: --cursor ");
    out = [];
    expect(await run(["query", "--actions", "invoice.*", "--json"])).toBe(0);
    expect((JSON.parse(stdout()) as { items: unknown[] }).items).toHaveLength(1);
    out = [];
    expect(await run(["query", "--tenant", "nobody"])).toBe(0);
    expect(stdout()).toContain("No events.");

    out = [];
    expect(await run(["tenants"])).toBe(0);
    expect(stdout()).toContain("acme  seq 2  2 event(s)");
  });

  test("record usage and input errors", async () => {
    expect(await run(["record", "--tenant", "acme"])).toBe(1);
    expect(stderr()).toContain("Usage: xtandard-audit record");
    expect(await run(["record", "--event", "{nope"])).toBe(1);
    expect(
      await run(["record", "--tenant", "a", "--action", "b", "--actor", "c", "--metadata", "{"]),
    ).toBe(1);
    expect(
      await run(["record", "--event", JSON.stringify({ tenant: "a", action: "bad action" })]),
    ).toBe(1);
    expect(stderr()).toContain("Validation failed");
  });

  test("tenants and actions when empty; actions lists the catalog", async () => {
    expect(await run(["tenants"])).toBe(0);
    expect(stdout()).toContain("No tenants.");
    expect(await run(["actions"])).toBe(0);
    expect(stdout()).toContain("No actions in the catalog.");
    const { createMemoryStorage } = await import("../src/entry-storage-memory.ts");
    await createAuditCore({ storage: createMemoryStorage() }).upsertAction({
      name: "invoice.paid",
      group: "Billing",
      description: "Paid",
      deprecated: true,
    });
    out = [];
    expect(await run(["actions"])).toBe(0);
    expect(stdout()).toContain("invoice.paid  [Billing]  (deprecated)  Paid");
  });

  test("export to stdout and to a file", async () => {
    await run(["record", "--tenant", "acme", "--action", "a.b", "--actor", "u"]);
    out = [];
    expect(await run(["export", "--tenant", "acme", "--format", "csv"])).toBe(0);
    expect(stdout().split("\n")[0]).toContain("id,tenant,seq");
    const file = join(dir, "acme.jsonl");
    expect(await run(["export", "--tenant", "acme", "--out", file])).toBe(0);
    expect(readFileSync(file, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(1);
    expect(stderr()).toContain(`Exported jsonl → ${file}`);
    expect(await run(["export"])).toBe(1);
    expect(await run(["export", "--tenant", "acme", "--format", "xml"])).toBe(1);
  });

  test("checkpoint needs a signer; then verify --tenant is anchored and signed", async () => {
    await run(["record", "--tenant", "acme", "--action", "a.b", "--actor", "u"]);
    expect(await run(["checkpoint"])).toBe(1);
    expect(await run(["checkpoint", "--tenant", "acme"])).toBe(1);
    expect(stderr()).toContain("No signer configured");
    expect(await run(["verify", "--tenant", "acme"])).toBe(2); // valid, unsigned
    process.env.AUDIT_HMAC_SECRET = "s";
    expect(await run(["checkpoint", "--tenant", "acme"])).toBe(0);
    expect(stdout()).toContain('"kind": "head"');
    out = [];
    expect(await run(["verify", "--tenant", "acme"])).toBe(0);
    expect(stdout()).toContain("VALID: 1 event(s)");
    expect(
      await run(["verify", "--tenant", "acme", "--fromSeq", "1", "--toSeq", "1", "--json"]),
    ).toBe(0);
    expect(await run(["verify"])).toBe(1);
  });

  test("prune applies RETENTION_* (and needs a policy)", async () => {
    expect(await run(["prune"])).toBe(1);
    expect(stderr()).toContain("No retention policy");
    for (const a of ["a.b", "a.c", "a.d"]) {
      await run(["record", "--tenant", "acme", "--action", a, "--actor", "u"]);
    }
    process.env.RETENTION_KEEP_LAST = "1";
    out = [];
    expect(await run(["prune", "--tenant", "acme"])).toBe(0);
    expect(stdout()).toContain("acme: pruned 2, first retained seq 3");
    out = [];
    expect(await run(["prune"])).toBe(0);
    expect(stdout()).toContain("acme: pruned");
  });

  test("keygen prints a private JWK and a public JWKS", async () => {
    expect(await run(["keygen"])).toBe(0);
    const [priv, pub] = stdout().trim().split("\n");
    const jwk = JSON.parse(priv!) as JsonWebKey & { kid: string };
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(jwk.d).toBeDefined();
    const jwks = JSON.parse(pub!) as { keys: (JsonWebKey & { kid: string })[] };
    expect(jwks.keys[0]!.d).toBeUndefined();
    expect(jwks.keys[0]!.kid).toBe(jwk.kid);
    expect(stderr()).toContain("AUDIT_SIGNING_KEY");
  });
});

describe("verify --bundle", () => {
  async function bundle(options: { sign: boolean; extra?: boolean }) {
    const { privateJwk, publicJwk } = await generateSigningKeyPair();
    const core = createAuditCore({
      storage: realMemoryStorage(),
      selfAudit: false,
      checkpoints: false,
      ...(options.sign ? { signer: await ed25519Signer(privateJwk) } : {}),
    });
    await core.recordMany([
      { tenant: "acme", action: "a.b", actor: { id: "u" } },
      { tenant: "acme", action: "a.c", actor: { id: "u" } },
    ]);
    if (options.sign) await core.checkpoint("acme");
    if (options.extra) await core.record({ tenant: "acme", action: "a.d", actor: { id: "u" } });
    const stream = await exportEvents(core, { tenant: "acme" }, { format: "bundle" });
    const text = await new Response(stream).text();
    const path = join(dir, "bundle.jsonl");
    await writeFile(path, text);
    const jwksPath = join(dir, "jwks.json");
    await writeFile(jwksPath, JSON.stringify({ keys: [publicJwk] }));
    return { path, jwksPath, text };
  }

  test("0: valid and every event covered by a verified checkpoint", async () => {
    const { path, jwksPath } = await bundle({ sign: true });
    expect(await run(["verify", "--bundle", path, "--jwks", jwksPath])).toBe(0);
    expect(stdout()).toContain("VALID: 2 event(s)");
    expect(stderr()).not.toContain("embedded in the bundle");
  });

  test("without --jwks, the embedded keys are used (with a note)", async () => {
    const { path } = await bundle({ sign: true });
    expect(await run(["verify", "--bundle", path])).toBe(0);
    expect(stderr()).toContain("embedded in the bundle");
  });

  test("2: valid but the tail is unsigned", async () => {
    const { path, jwksPath } = await bundle({ sign: true, extra: true });
    expect(await run(["verify", "--bundle", path, "--jwks", jwksPath])).toBe(2);
    expect(stdout()).toContain("events after seq 2 are not covered");
    const unsigned = await bundle({ sign: false });
    expect(await run(["verify", "--bundle", unsigned.path])).toBe(2);
    expect(stdout()).toContain("unsigned");
  });

  test("1: tampered", async () => {
    const { path, jwksPath, text } = await bundle({ sign: true });
    await writeFile(path, text.replace('"action":"a.c"', '"action":"a.x"'));
    expect(await run(["verify", "--bundle", path, "--jwks", jwksPath, "--json"])).toBe(1);
    expect((JSON.parse(stdout()) as VerifyReport).ok).toBe(false);
  });

  test("1: signature by a key that is not the operator's", async () => {
    const { path } = await bundle({ sign: true });
    const other = await generateSigningKeyPair();
    const otherPath = join(dir, "other.json");
    await writeFile(otherPath, JSON.stringify({ keys: [other.publicJwk] }));
    expect(await run(["verify", "--bundle", path, "--jwks", otherPath])).not.toBe(0);
  });

  test("--jwks over http(s)", async () => {
    const { path, jwksPath } = await bundle({ sign: true });
    const body = readFileSync(jwksPath, "utf8");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(new Response("nope", { status: 404 }));
    expect(await run(["verify", "--bundle", path, "--jwks", "https://x.test/keys"])).toBe(0);
    expect(await run(["verify", "--bundle", path, "--jwks", "https://x.test/keys"])).toBe(1);
    expect(stderr()).toContain("→ 404");
    fetchSpy.mockRestore();
  });

  test("verifyExitCode", () => {
    const base: VerifyReport = {
      ok: true,
      tenant: "t",
      checked: 2,
      fromSeq: 1,
      toSeq: 2,
      headHash: "h",
      anchor: "genesis",
      linksChecked: true,
      checkpointsVerified: 1,
      signedThrough: 2,
      erased: [],
      issues: [],
    };
    expect(verifyExitCode(base)).toBe(0);
    expect(verifyExitCode({ ...base, ok: false })).toBe(1);
    expect(verifyExitCode({ ...base, signedThrough: 1 })).toBe(2);
    expect(verifyExitCode({ ...base, anchor: "unanchored" })).toBe(2);
    expect(verifyExitCode({ ...base, checked: 0, anchor: "none", signedThrough: null })).toBe(0);
  });
});

describe("serve auth", () => {
  // A typo must not fall through to `none` and serve an open admin panel: `run`
  // resolves (a listening server never would) with 1 before anything listens.
  test.each(["basci", "BASIC", "Basic"])(
    "serve rejects unknown AUTH_MODE=%s and exits 1 without listening",
    async (mode) => {
      process.env.AUTH_MODE = mode;
      process.env.PORT = "4399";
      expect(await run(["serve"])).toBe(1);
      expect(stderr()).toContain(`Unknown AUTH_MODE "${mode}" (expected none or basic)`);
      expect(stderr()).not.toContain("AUTH_MODE=none");
      expect(stdout()).not.toContain("listening");
    },
  );
});
