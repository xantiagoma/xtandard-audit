# Auth

Who is making this request? Authentication is a pluggable provider on the panel; three ship, and the contract is one function if you need your own. (Whether they _may_ do it is authorization — [Authorization](./AUTHORIZATION.md). Portal tokens are a third, separate lane — [Portal](./PORTAL.md).)

## The contract

```ts
interface Principal {
  id: string;
  email?: string;
  name?: string;
  roles?: string[];
  metadata?: unknown;
}

interface AuthProvider {
  authenticate(request: Request): Promise<Principal | null>;
  /** Optional: the 401 to answer with (e.g. a `WWW-Authenticate` challenge). */
  challenge?(request: Request): Response | undefined;
}
```

Return a `Principal` to admit, or `null` for "not authenticated" (the handler answers `challenge()` or a plain JSON 401). A provider that **throws** is a backend failure (IdP down) and answers 500, not a misleading 401.

The principal is also the **actor** of control-plane operations: erasures, exports, checkpoints, prunes and catalog edits are self-audited with `{ id, name, email }` of the principal (`type: "operator"`), and events recorded through `POST /api/tenants/:tenant/events` without an `actor` default to the principal (`type: "api"`).

## Bundled providers

### `@xtandard/audit/auth/none` (default)

```ts
import { noAuth, ANONYMOUS_PRINCIPAL } from "@xtandard/audit/auth/none";
```

Everyone is `anonymous`. The default so the five-minute quickstart works — put anything internet-reachable behind real auth.

### `@xtandard/audit/auth/basic`

```ts
import { basicAuth, hashPassword } from "@xtandard/audit/auth/basic";

const auth = basicAuth({
  users: [{ username: "ops", passwordHash: await hashPassword("s3cret"), roles: ["admin"] }],
});
```

HTTP Basic with scrypt password hashes (never plaintext at rest), timing-safe verification, and a proper `WWW-Authenticate` challenge. Pair with `AUTH_MODE=basic` + `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` (and `AUTH_ROLE`) on the CLI/standalone. `AUTH_MODE` accepts only `none` (the default, also when empty) or `basic`; any other value (e.g. a typo like `basci`) is rejected at startup rather than falling back to an open panel.

### `@xtandard/audit/auth/delegated`

```ts
import { delegatedAuth } from "@xtandard/audit/auth/delegated";

const auth = delegatedAuth({
  async authenticate(request) {
    const session = await myApp.getSession(request); // your cookie/JWT/IdP
    return session ? { id: session.userId, email: session.email, roles: session.roles } : null;
  },
});
```

The integration point for the auth your app already has — the panel never sees credentials, only your resolved principal.

## Wiring

```ts
auditPanel({
  storage,
  auth, // AuthProvider
  authorization, // see docs/AUTHORIZATION.md
  portal: { secret }, // optional third lane, see docs/PORTAL.md
});
```

Order of evaluation per request: a presented `audpt_` bearer token wins (and, if invalid, fails closed with 401 — it never falls back to host auth); otherwise your `auth` provider runs. Public routes skip auth entirely: `/api/openapi.json`, `/api/integrity/keys` (the JWKS auditors verify against) and static UI assets. `/config` runs auth but never rejects — it reports `principal: null` so the UI can show a sign-in state.
