/**
 * Integration test for the CLI `serve` command. It boots in a subprocess (so
 * the never-resolving `run([...])` doesn't hang the test), then probes the
 * healthcheck, basic-auth enforcement, recording, a streamed export, the
 * public JWKS and portal tokens. Spawned via Bun, so it runs under `bun test`
 * (not vitest).
 *
 *   bun test test/cli-serve.bun.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { generateSigningKeyPair } from "../src/integrity.ts";
import { createPortalToken } from "../src/portal.ts";

const PORT = 4400 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const AUTH = { authorization: `Basic ${btoa("admin:secret")}` };
const { privateJwk } = await generateSigningKeyPair();

const serveProc = Bun.spawn(["bun", "-e", "import('./src/cli.ts').then((m) => m.run(['serve']))"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    BASE_PATH: "/audit",
    AUTH_MODE: "basic",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "secret",
    STORAGE_DRIVER: "memory",
    AUDIT_SIGNING_KEY: JSON.stringify(privateJwk),
    PORTAL_SECRET: "portal-secret",
    RETENTION_MAX_AGE: "365d",
  },
  stdout: "pipe",
  stderr: "pipe",
});

// Empty AUTH_MODE means the default `none` (not an unknown mode).
const OPEN_PORT = PORT + 500;
const openProc = Bun.spawn(["bun", "-e", "import('./src/cli.ts').then((m) => m.run(['serve']))"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(OPEN_PORT), AUTH_MODE: "", STORAGE_DRIVER: "memory" },
  stdout: "pipe",
  stderr: "pipe",
});

afterAll(() => {
  serveProc.kill();
  openProc.kill();
});

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`${url} did not become ready in time`);
}

test("serve: healthcheck answers without auth", async () => {
  await waitForServer(`${BASE}/healthcheck`);
  const res = await fetch(`${BASE}/audit/healthcheck`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
}, 30_000);

test("serve: the API requires basic auth", async () => {
  const res = await fetch(`${BASE}/audit/api/tenants`);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain("Basic");
  const ok = await fetch(`${BASE}/audit/api/tenants`, { headers: AUTH });
  expect(ok.status).toBe(200);
});

test("serve: records, checkpoints with the env signer, and streams an export", async () => {
  const rec = await fetch(`${BASE}/audit/api/tenants/acme/events`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ action: "invoice.paid", actor: { id: "u1" } }),
  });
  expect(rec.status).toBe(201);
  const cp = await fetch(`${BASE}/audit/api/tenants/acme/checkpoints`, {
    method: "POST",
    headers: AUTH,
  });
  expect(cp.status).toBe(201);
  expect((await cp.json()).alg).toBe("Ed25519");
  const exp = await fetch(`${BASE}/audit/api/tenants/acme/export?format=bundle`, {
    headers: AUTH,
  });
  expect(exp.headers.get("content-disposition")).toContain("acme-audit-");
  expect((await exp.text()).split("\n")[0]).toContain("xtandard-audit-bundle");
  const keys = await fetch(`${BASE}/audit/api/integrity/keys`);
  expect(((await keys.json()) as { keys: unknown[] }).keys).toHaveLength(1);
});

test("serve: portal tokens minted with PORTAL_SECRET are honored", async () => {
  const token = await createPortalToken("portal-secret", "acme");
  const res = await fetch(`${BASE}/audit/config`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await res.json()).toMatchObject({ portal: true, tenant: "acme" });
});

test("serve: exits non-zero on an unknown AUTH_MODE instead of serving an open panel", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      "import('./src/cli.ts').then((m) => m.run(['serve'])).then((code) => process.exit(code))",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(OPEN_PORT + 1),
        AUTH_MODE: "basci",
        STORAGE_DRIVER: "memory",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => proc.kill(), 20_000);
  const code = await proc.exited;
  clearTimeout(timeout);
  expect(code).not.toBe(0);
  expect(await new Response(proc.stderr).text()).toContain(
    'Unknown AUTH_MODE "basci" (expected none or basic)',
  );
  expect(await new Response(proc.stdout).text()).not.toContain("listening");
}, 30_000);

test("serve: an empty AUTH_MODE defaults to none", async () => {
  const base = `http://localhost:${OPEN_PORT}`;
  await waitForServer(`${base}/healthcheck`);
  expect((await fetch(`${base}/api/tenants`)).status).toBe(200);
}, 30_000);
