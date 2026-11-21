/**
 * The admin dashboard and the customer portal as React components, to embed in
 * your own app (advanced mode). Most users mount the bundled SPA via a framework
 * adapter and never touch React; this is for teams that want the panel inside an
 * existing React shell.
 *
 * Two components share the same SPA internals:
 *
 * ```tsx
 * import { AuditDashboard, AuditPortal } from "@xtandard/audit/react";
 * import "@xtandard/audit/react/styles.css";
 *
 * // Full admin — point it at wherever the panel API is mounted:
 * <AuditDashboard apiBaseUrl="/audit" />
 *
 * // Customer-scoped portal — pass a portal token minted server-side:
 * <AuditPortal apiBaseUrl="/audit" token={portalToken} />
 * ```
 *
 * `react` and `react-dom` are peer dependencies in this mode. The components are
 * self-contained otherwise (TanStack Query and styles are bundled).
 *
 * Import from `@xtandard/audit/react`.
 *
 * @module react
 */

import type React from "react";
import type { QueryClient } from "@tanstack/react-query";
import { createEmbed, type EmbedBaseProps, type EmbedRouting } from "@xtandard/kit/ui/embed";
import type { FetchLike } from "@xtandard/kit/ui";
import { App } from "./ui/App.tsx";
import * as api from "./ui/api.ts";
import { themeStore } from "./ui/theme.ts";
import "./ui/styles.css";

/** Theme modes for the embedded components (see {@link AuditDashboardProps.theme}). */
export type EmbedTheme = "auto" | "inherit" | "light" | "dark";

/** Props for {@link AuditDashboard}. */
export interface AuditDashboardProps extends EmbedBaseProps {
  /**
   * Base URL where the panel API + `/config` are mounted (e.g. `"/audit"` or
   * `"https://admin.example.com/audit"`). Defaults to `""` (same origin, relative).
   */
  apiBaseUrl?: string;
  /**
   * `credentials` mode for API requests. Defaults to `"same-origin"`. For a
   * **cross-origin** embed (panel served from a different origin than this app)
   * with cookie-based auth, set `"include"` — and enable `cors` on the panel
   * server so it returns `Access-Control-Allow-Credentials`.
   */
  credentials?: RequestCredentials;
  /**
   * Custom `fetch` for API requests — inject a bearer token / extra headers, or
   * instrument calls. Defaults to the global `fetch`.
   */
  fetch?: FetchLike;
  /** Bring your own QueryClient; one is created if omitted. */
  queryClient?: QueryClient;
  /**
   * Theme handling. The embed never writes to the host document — it resolves a
   * theme and applies it to its own wrapper (`data-theme`), so surfaces, text,
   * borders and code views always come from one theme.
   * - `"auto"` (default) — the panel's own system/light/dark switcher (preference
   *   persisted in localStorage).
   * - `"inherit"` — follow the host page, live: a `dark`/`light` class or
   *   `data-theme` attribute on `<html>` (then `<body>`), falling back to the OS
   *   `prefers-color-scheme`. The switcher is hidden; the host owns the theme.
   * - `"light"` / `"dark"` — force one theme (switcher hidden). Useful when the
   *   host tracks its theme some other way: pass its resolved value.
   */
  theme?: EmbedTheme;
  /** Extra className on the dashboard root wrapper. */
  className?: string;
  /**
   * How the dashboard routes between views/records.
   * - `"hash"` (default) — routes in `location.hash`; never touches the host app's
   *   router or pathname. Safest when mounted inside another app.
   * - `"browser"` — real history paths (clean URLs). Requires the host to serve the
   *   panel's `index.html` as a catch-all under `routerBase`, else refresh 404s.
   * - `"memory"` — in-memory only; no URL coupling at all.
   * - a custom wouter location hook for full control.
   */
  routing?: EmbedRouting;
  /** Base path the panel is mounted at, used by `routing: "browser"` (e.g. `"/admin/audit"`). */
  routerBase?: string;
  /** Navbar logo image URL (replaces the title wordmark). Overrides server `/config`. */
  logoUrl?: string;
  /**
   * Pre-select a tenant on first render, overriding the default ("All
   * tenants") — e.g. an admin panel embedding one dashboard per customer. The
   * URL still wins when it names one (`?tenant=`), so deep links and the in-app
   * switcher behave normally afterwards.
   */
  initialTenant?: string;
}

/** Props for {@link AuditPortal}. */
export interface AuditPortalProps extends Omit<AuditDashboardProps, "initialTenant"> {
  /**
   * Portal token (`audpt_…`) minted server-side via `createPortalToken()`. Sent as
   * an `Authorization: Bearer` credential on every API request; `/config` then
   * reports `portal: true` and the shell renders the reduced, tenant-pinned
   * portal chrome (Events explorer, export, integrity verification).
   */
  token: string;
}

/**
 * The shared embed plumbing (`@xtandard/kit/ui/embed`): one theme per embed on
 * the `.xtandard-audit` wrapper, toasts and Base UI portals inside it, the
 * memory router keeping its query string, and the portal token attached
 * synchronously (queries refetch when it changes; it is cleared on unmount).
 */
const embed = createEmbed<{ initialTenant?: string }>({
  App,
  scopeClass: "xtandard-audit",
  api,
  themeKey: themeStore,
  tokenRouting: "hash", // the portal routes in the hash too, as it always has
  displayNames: { dashboard: "AuditDashboard", token: "AuditPortal" },
});

/** The full audit-log admin dashboard as an embeddable React component. */
export const AuditDashboard: React.FC<AuditDashboardProps> = embed.Dashboard;

/**
 * The customer-facing log viewer as an embeddable React component. Renders
 * the same shell as {@link AuditDashboard} with the portal token attached as
 * a Bearer credential; the server scopes every request to the token's tenant
 * (and its optional view filter) and the shell renders the reduced portal
 * chrome from the first render.
 */
export const AuditPortal: React.FC<AuditPortalProps> = embed.TokenEmbed;

export { setApiBase, setApiToken } from "./ui/api.ts";
export type { FetchLike };
export {
  setThemePref,
  getThemePref,
  detectHostTheme,
  type ThemePref,
  type ResolvedTheme,
} from "./ui/theme.ts";
export default AuditDashboard;
