/**
 * Auth + authorization flexibility demo. One server; `AUTH_DEMO` selects the mode:
 *
 *   AUTH_DEMO=none|basic|delegated|roles bun run src/index.ts
 *
 * `none` (open), `basic` (hashed + plaintext passwords), `delegated`
 * (bring-your-own: an `X-API-Key` lookup in ~5 lines), and `roles` (three
 * users — admin / auditor / viewer — through the default role policy). Whatever
 * the mode, a **portal-token mint route** (`POST /portal-token?tenant=acme`)
 * runs side by side: your backend mints a scoped `audpt_…` token with
 * `createPortalToken` and hands it to a customer's browser — the panel then
 * confines that bearer to their own tenant (and, optionally, a view filter).
 *
 * See ../README.md for curl commands per mode.
 */
import { createFetchHandler, createPortalToken } from "@xtandard/audit";
import type { AuthProvider, AuthorizationProvider, PortalFilter } from "@xtandard/audit";
import { basicAuth, hashPassword } from "@xtandard/audit/auth/basic";
import { delegatedAuth } from "@xtandard/audit/auth/delegated";
import { noAuth } from "@xtandard/audit/auth/none";
import { noAuthorization } from "@xtandard/audit/authorization/none";
import { rolesAuthorization } from "@xtandard/audit/authorization/roles";
import { createMemoryStorage } from "@xtandard/audit/storage/memory";

// The portal secret NEVER reaches a browser — it only mints and verifies tokens.
const PORTAL_SECRET = process.env.PORTAL_SECRET ?? "demo-portal-secret-change-me";

/** Demo API key → principal table for the `delegated` mode. */
const API_KEYS: Record<string, { id: string; name: string; roles: string[] }> = {
  "key-admin": { id: "alice", name: "Alice (platform)", roles: ["admin"] },
  "key-auditor": { id: "bob", name: "Bob (compliance)", roles: ["auditor"] },
  "key-viewer": { id: "carol", name: "Carol (support)", roles: ["viewer"] },
};

const mode = process.env.AUTH_DEMO ?? "roles";
let auth: AuthProvider;
// The default policy: admin → everything; auditor → reads + export + checkpoint;
// viewer → reads only. Erasure and pruning stay with admins.
let authorization: AuthorizationProvider = rolesAuthorization();

switch (mode) {
  case "none":
    auth = noAuth();
    authorization = noAuthorization(); // allow everything — a private-network quickstart only
    break;
  case "basic":
    auth = basicAuth({
      users: [
        // Encrypted (scrypt) — preferred. The stored value is a `scrypt$…` digest.
        { username: "admin", passwordHash: await hashPassword("s3cret"), roles: ["admin"] },
        // Plaintext — DEV ONLY. Never ship a real password as cleartext.
        { username: "dev", password: "dev", roles: ["admin"] },
      ],
    });
    break;
  case "delegated":
    // Bring-your-own authentication: an AuthProvider is just Request → Principal.
    auth = delegatedAuth({
      authenticate: (request) => {
        const key = request.headers.get("x-api-key");
        return key ? (API_KEYS[key] ?? null) : null;
      },
    });
    break;
  case "roles":
    auth = basicAuth({
      users: [
        { username: "alice", passwordHash: await hashPassword("alice"), roles: ["admin"] },
        { username: "bob", passwordHash: await hashPassword("bob"), roles: ["auditor"] },
        { username: "carol", passwordHash: await hashPassword("carol"), roles: ["viewer"] },
      ],
    });
    break;
  default:
    console.error(`Unknown AUTH_DEMO="${mode}". Use: none|basic|delegated|roles`);
    process.exit(1);
}

const panel = createFetchHandler({
  basePath: "",
  storage: createMemoryStorage(),
  title: `Auth demo: ${mode}`,
  auth,
  authorization,
  // Portal tokens compose with EVERY auth mode: a valid audpt_… bearer becomes
  // a portal principal scoped to its token's tenant (and view filter).
  portal: { secret: PORTAL_SECRET },
});

// A little history in two tenants, so there is something to read, scope and filter.
const support = { id: "staff_jordan", type: "support", name: "Jordan (Support)" };
const ada = { id: "usr_ada", name: "Ada Lovelace", email: "ada@acme.com" };
await panel.core.recordMany([
  { tenant: "acme", action: "user.login", actor: ada, metadata: { method: "sso" } },
  {
    tenant: "acme",
    action: "member.invited",
    actor: ada,
    targets: [{ type: "user", id: "usr_grace", name: "grace@acme.com" }],
  },
  {
    tenant: "acme",
    action: "support.impersonation_started",
    actor: support,
    targets: [{ type: "user", id: "usr_ada" }],
    metadata: { ticket: "SUP-4821" },
  },
  { tenant: "acme", action: "invoice.paid", actor: { id: "system:billing", type: "system" } },
  { tenant: "globex", action: "user.login", actor: { id: "usr_hank", name: "Hank Scorpio" } },
]);

const port = Number(process.env.PORT) || 3000;
Bun.serve({
  port,
  fetch: async (request) => {
    const url = new URL(request.url);
    // The mint route lives in YOUR backend (behind YOUR auth in real life): mint a
    // token for the customer whose settings page is asking, hand it to their
    // browser, and the panel confines it to that tenant. `?hide=support.*` adds a
    // view filter — AND-ed server-side into every query, export and read.
    if (url.pathname === "/portal-token" && request.method === "POST") {
      const tenant = url.searchParams.get("tenant") ?? "acme";
      const hide = url.searchParams.get("hide");
      const filter: PortalFilter | undefined = hide
        ? { excludeActions: hide.split(",") }
        : undefined;
      const token = await createPortalToken(PORTAL_SECRET, tenant, {
        expiresIn: "1h",
        ...(filter ? { filter } : {}),
      });
      return Response.json({ token, tenant, expiresIn: "1h", ...(filter ? { filter } : {}) });
    }
    return panel.fetch(request);
  },
});

console.log(`auth demo "${mode}" on http://localhost:${port}\n`);
if (mode === "delegated") {
  console.log("API keys (X-API-Key header): key-admin | key-auditor | key-viewer\n");
}
if (mode === "roles")
  console.log("Users: alice/alice (admin), bob/bob (auditor), carol/carol (viewer)\n");
console.log("Try the admin API (who you are decides what you may do):");
console.log(`  curl -s localhost:${port}/api/tenants`);
console.log("Mint a customer-scoped portal token (works in every mode):");
console.log(`  curl -s -X POST 'localhost:${port}/portal-token?tenant=acme&hide=support.*'`);
console.log("…then use it as a bearer:");
console.log(
  `  curl -s -H 'authorization: Bearer <token>' localhost:${port}/api/tenants/acme/events`,
);
