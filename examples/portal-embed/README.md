# portal-embed × @xtandard/audit

Embed the **customer-facing audit log** as a React component inside your own
app — an "Organization settings → Audit log" page where each customer browses,
filters, exports and verifies only _their_ organization's events.

```tsx
import { AuditPortal } from "@xtandard/audit/react";
import "@xtandard/audit/react/styles.css";

// token = an audpt_… portal token your backend minted with createPortalToken()
<AuditPortal apiBaseUrl="https://api.example.com/audit" token={token} />;
```

`react` + `react-dom` are peers. Build the package at the repo root first
(`bun run build` — it includes the React embed's `build:react` step).

## What's here

- **`start.ts`** — boots an in-memory panel on **:3702**, seeded with three
  weeks of `acme`'s activity, an Ed25519 signer and a checkpoint (so **Verify**
  has something to check), plus one `globex` event the token must never show.
  It is configured with `portal: { secret }` + `cors` for the Vite origin, and
  serves **`POST /api/audit-portal-token`** — standing in for the _host app's_
  session-guarded route that mints a token for the signed-in user's org with
  `createPortalToken()`. The secret never reaches the browser.
- **A Vite React host app** on **:5191** — fetches `/api/audit-portal-token`
  (proxied to the demo server so it looks same-origin, like your own backend),
  then renders `<AuditPortal>` pointed cross-origin at the panel.

Because the token rides as an `Authorization: Bearer` header (no cookies), the
cross-origin embed only needs the panel's `cors` option — no `credentials`.

## Run it

```bash
# from the repo root — boots the seeded panel on :3702 + the vite host app:
bun run examples:portal-embed          # → http://localhost:5191

# or manually, in this directory:
bun install
bun run start                          # panel + mint route + vite in one command
```

## The loop

1. Open <http://localhost:5191>. The host app mints a portal token for `acme`
   and mounts the portal: pinned to that tenant — no tenant switcher, no
   streams, no erase — with events, export and **Verify log integrity**.
2. Filter, open an event, export CSV or a verifiable bundle: everything the
   bearer does is confined to `acme` (and recorded in acme's own log as
   `audit_log.exported` by `portal:acme`).
3. Check the scoping from outside:

   ```bash
   TOKEN=$(curl -s -X POST localhost:3702/api/audit-portal-token | jq -r .token)
   curl -s -H "authorization: Bearer $TOKEN" localhost:3702/config | jq '{portal, tenant, allowed}'
   curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" \
     localhost:3702/api/tenants/globex/events                       # 403
   ```

## Files

- [`start.ts`](./start.ts) — the seeded panel, the mint route, and the Vite spawn.
- [`src/App.tsx`](./src/App.tsx) — the host app: fetch a token, render `<AuditPortal>`.
- [`vite.config.ts`](./vite.config.ts) — proxies the mint route; the panel API itself is cross-origin.
