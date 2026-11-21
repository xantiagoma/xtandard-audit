import React from "react";
import { AuditPortal } from "@xtandard/audit/react";
import "@xtandard/audit/react/styles.css";

/** Where the audit panel API lives — a DIFFERENT origin than this host app. */
const PANEL_URL = "http://localhost:3702";

/**
 * A host SaaS app embedding the customer-facing audit log on one of its routes
 * ("Organization settings → Audit log"). The flow:
 *
 * 1. The frontend asks ITS OWN backend for a portal token
 *    (`/api/audit-portal-token`, proxied by Vite — in real life a
 *    session-guarded route that mints a token for the signed-in user's org with
 *    `createPortalToken`).
 * 2. `<AuditPortal>` sends the token as a Bearer credential on every panel API
 *    request; the panel confines it to the token's tenant (and its view
 *    filter) and renders the reduced portal chrome: events, export, verify.
 *
 * Tokens are short-lived: re-mint before `expiresIn` and pass the new `token`
 * prop — the component picks it up without remounting.
 */
export function App(): React.ReactElement {
  const [token, setToken] = React.useState<string>();
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    fetch("/api/audit-portal-token", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Token mint failed: HTTP ${res.status}`);
        const body = (await res.json()) as { token: string };
        setToken(body.token);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div style={{ minHeight: "100vh" }}>
      <div
        style={{
          background: "#111827",
          color: "#fff",
          padding: "10px 20px",
          font: "600 14px system-ui",
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <span style={{ opacity: 0.6 }}>Acme Cloud</span>
        <span style={{ opacity: 0.3 }}>/</span>
        <span style={{ opacity: 0.6 }}>Organization settings</span>
        <span style={{ opacity: 0.3 }}>/</span>
        <span>Audit log</span>
      </div>
      {error ? (
        <p style={{ font: "14px system-ui", padding: 20 }}>
          Could not mint a portal token ({error}) — is <code>start.ts</code> running?
        </p>
      ) : token ? (
        <AuditPortal apiBaseUrl={PANEL_URL} token={token} theme="light" />
      ) : (
        <p style={{ font: "14px system-ui", padding: 20 }}>Minting a portal token…</p>
      )}
    </div>
  );
}
