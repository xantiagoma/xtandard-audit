/**
 * A minimal host app for the React-embed e2e (see e2e/embed.spec.ts), bundled
 * on demand by e2e/server.ts. Mounts the **built** embed (`dist/react.js` +
 * the scoped `dist/react.css`) — the artifact consumers install — not the
 * sources.
 *
 * Query params:
 * - `mode` → `dashboard` (default) renders `<AuditDashboard>`; `portal` mints a
 *   token from the host's own route (`/e2e/portal-token?tenant=`) and renders
 *   `<AuditPortal>`, exactly like a host product would.
 * - `tenant` → the portal token's tenant (default `acme`).
 * - `theme` → the `theme` prop (`auto | inherit | light | dark`).
 *
 * The host theme itself is set by the page markup / the test (a `dark` class or
 * `data-theme` on `<html>`), mimicking class- and attribute-based switchers.
 *
 * @module
 */

import React from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error — built artifact (no sibling .d.ts at this path); typed via src/react.tsx.
import { AuditDashboard, AuditPortal } from "../dist/react.js";
import type { EmbedTheme } from "../src/react.tsx";

const params = new URLSearchParams(location.search);
const theme = (params.get("theme") ?? "inherit") as EmbedTheme;
const mode = params.get("mode") ?? "dashboard";
const tenant = params.get("tenant") ?? "acme";

function PortalHost() {
  const [token, setToken] = React.useState<string>();
  React.useEffect(() => {
    // The host's own session-guarded route mints a tenant-scoped token.
    void fetch(`/e2e/portal-token?tenant=${encodeURIComponent(tenant)}`)
      .then((r) => r.json())
      .then((body: { token: string }) => setToken(body.token));
  }, []);
  if (!token) return <p>Loading…</p>;
  return <AuditPortal apiBaseUrl={location.origin} token={token} routing="memory" theme={theme} />;
}

createRoot(document.getElementById("host-root")!).render(
  <main>
    <h2 className="host-heading">Host app</h2>
    {mode === "portal" ? (
      <PortalHost />
    ) : (
      <AuditDashboard apiBaseUrl={location.origin} routing="memory" theme={theme} />
    )}
  </main>,
);
