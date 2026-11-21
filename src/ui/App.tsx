import React from "react";
import { Router, Switch, Route, useSearchParams } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useQuery } from "@tanstack/react-query";
import {
  BrandMark,
  canLeave,
  ConfigError,
  Dropdown,
  readConfigGlobal,
  ShellFrame,
  useShellConfig,
  useShellNav,
  type ShellAppProps,
} from "@xtandard/kit/ui";
import type { AuditConfig, PanelAction } from "./types.ts";
import { getApiToken, getConfig, listTenants } from "./api.ts";
import { OverviewView } from "./views/OverviewView.tsx";
import { EventsView } from "./views/EventsView.tsx";
import { TenantsView } from "./views/TenantsView.tsx";
import { ActionsView } from "./views/ActionsView.tsx";
import { IntegrityView } from "./views/IntegrityView.tsx";
import { StreamsView } from "./views/StreamsView.tsx";
import { can } from "./lib/format.ts";
import symbol from "./brand/symbol.svg?raw";
import symbolLight from "./brand/symbol-light.svg?raw";

interface NavTab {
  path: string;
  label: string;
  match: (loc: string) => boolean;
  /** Hidden unless `/config.allowed` lists it. */
  requires: PanelAction;
  /** Hidden in portal mode regardless of `allowed`. */
  adminOnly?: boolean;
  /** Hidden when the panel has no stream runner. */
  streams?: boolean;
}

// Nav tabs map to route paths. "Overview" is the index ("/") in admin mode;
// portal mode hides the operator views and lands on Events.
const NAV_TABS: NavTab[] = [
  {
    path: "/",
    label: "Overview",
    match: (l) => l === "/",
    requires: "tenant:read",
    adminOnly: true,
  },
  {
    path: "/events",
    label: "Events",
    match: (l) => l.startsWith("/events"),
    requires: "event:read",
  },
  {
    path: "/tenants",
    label: "Tenants",
    match: (l) => l.startsWith("/tenants"),
    requires: "tenant:read",
    adminOnly: true,
  },
  {
    path: "/actions",
    label: "Actions",
    match: (l) => l.startsWith("/actions"),
    requires: "action:read",
  },
  {
    path: "/integrity",
    label: "Integrity",
    match: (l) => l.startsWith("/integrity"),
    requires: "integrity:read",
  },
  {
    path: "/streams",
    label: "Streams",
    match: (l) => l.startsWith("/streams"),
    requires: "stream:read",
    adminOnly: true,
    streams: true,
  },
];

// Query params that survive tab navigation: the shell's tenant context and the
// standalone portal token. View-local params (filters, the open event) don't.
const STICKY_PARAMS = ["tenant", "token"];

/** Everything a view needs from the shell. */
export interface ShellContext {
  config: AuditConfig;
  readonly: boolean;
  portal: boolean;
  /** Selected tenant; `""` = all tenants (admin only). Pinned in portal mode. */
  tenant: string;
  setTenant: (tenant: string) => void;
  /** Navigate in-app (keeps the tenant context, consults the nav guard). */
  go: (path: string, params?: Record<string, string>) => void;
  can: (action: PanelAction) => boolean;
}

/**
 * The dashboard, wrapped in a wouter {@link Router}. `locationHook` + `base` make
 * routing pluggable: the bundled SPA uses browser history (clean paths, served by
 * the handler's SPA catch-all), while the embeddable defaults to hash routing so
 * it never touches the host app's router. Pass a custom hook (e.g. memory) to override.
 */
export function App({
  locationHook,
  searchHook,
  base = "",
  logoUrl,
  initialTenant,
  showThemeToggle,
  forcePortal,
}: ShellAppProps & {
  /** Pre-select a tenant when the URL doesn't name one (embed hosts). */
  initialTenant?: string;
}): React.ReactElement {
  return (
    <Router hook={locationHook ?? useHashLocation} searchHook={searchHook} base={base}>
      <AppShell
        logoUrl={logoUrl}
        initialTenant={initialTenant}
        showThemeToggle={showThemeToggle}
        forcePortal={forcePortal}
      />
    </Router>
  );
}

function AppShell({
  logoUrl,
  initialTenant,
  showThemeToggle,
  forcePortal,
}: {
  logoUrl?: string;
  initialTenant?: string;
  showThemeToggle?: boolean;
  forcePortal?: boolean;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  // `ready`/`adminReady` stay false until /config answers, and a portal token
  // means portal from the first render, so no admin request fires for a portal.
  const shell = useShellConfig<AuditConfig>({
    getConfig,
    bootstrap: readConfigGlobal<AuditConfig>("__AUDIT_CONFIG__"),
    token: getApiToken(),
    forcePortal,
  });
  const config = shell.config as AuditConfig;
  const { readonly, portal } = shell;
  const allowed = (action: PanelAction) => can(config, action);

  // Branding: explicit props win, then server /config, then defaults.
  const brandTitle = config.title || "@xtandard/audit";
  const brandLogoUrl = logoUrl ?? config.logoUrl;

  const tenantsQuery = useQuery({
    queryKey: ["tenants"],
    queryFn: listTenants,
    staleTime: 30_000,
    enabled: shell.adminReady && allowed("tenant:read"),
  });
  const tenants = tenantsQuery.data ?? [];

  // Tenant precedence: portal pins the token's tenant; otherwise the URL wins
  // (a shared link restores context; the switcher writes here), then the embed
  // host's initial prop, then "all tenants".
  const tenant = portal
    ? (config.tenant ?? "")
    : (searchParams.get("tenant") ?? initialTenant ?? "");

  // All in-app navigation funnels through `go`, which consults the nav guard —
  // a view with unsaved edits can veto the move (wouter has no built-in blocker).
  const go = useShellNav({ stickyParams: STICKY_PARAMS });

  const setTenant = (key: string) => {
    if (!canLeave()) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (key) next.set("tenant", key);
        else next.delete("tenant");
        // An open event belongs to the previous context.
        next.delete("event");
        next.delete("eventTenant");
        return next;
      },
      { replace: false },
    );
  };

  const streamsEnabled = config.features?.streams !== false;
  const showOverview = !portal && allowed("tenant:read");
  const tabs = NAV_TABS.filter(
    (t) => (!portal || !t.adminOnly) && allowed(t.requires) && (!t.streams || streamsEnabled),
  ).map(({ path, label, match }) => ({
    path,
    label,
    // Without an Overview tab, "/" renders Events — highlight it.
    match: (loc: string) => match(loc) || (!showOverview && loc === "/" && path === "/events"),
  }));

  const ctx: ShellContext = { config, readonly, portal, tenant, setTenant, go, can: allowed };

  const switcher = portal ? (
    // Portal chrome: no switcher — the token pins the tenant.
    tenant ? (
      <span className="font-mono text-[13px] text-muted-foreground">{tenant}</span>
    ) : null
  ) : allowed("tenant:read") ? (
    <Dropdown
      aria-label="Tenant"
      value={tenant}
      onValueChange={setTenant}
      options={[
        { value: "", label: "All tenants" },
        ...tenants.map((t) => ({ value: t.key, label: t.key })),
        // Keep a URL-named tenant selectable before/without the list.
        ...(tenant && !tenants.some((t) => t.key === tenant)
          ? [{ value: tenant, label: tenant }]
          : []),
      ]}
      className="w-48 font-mono"
    />
  ) : null;

  return (
    <ShellFrame
      title={brandTitle}
      logoUrl={brandLogoUrl}
      // The bare symbol (SVG, no tile), in each theme's lime (docs/BRAND.md).
      brandMark={<BrandMark light={symbolLight} dark={symbol} className="h-6 w-auto" />}
      switcher={switcher}
      readonly={readonly}
      portal={portal}
      showThemeToggle={showThemeToggle}
      tabs={tabs}
      onNavigate={(path) => go(path)}
      fallback={shell.failed ? <ConfigError /> : null}
    >
      {shell.loading ? null : (
        <Switch>
          <Route path="/events">
            <EventsView ctx={ctx} />
          </Route>
          {!portal && (
            <Route path="/tenants">
              <TenantsView ctx={ctx} />
            </Route>
          )}
          <Route path="/actions">
            <ActionsView ctx={ctx} />
          </Route>
          <Route path="/integrity">
            <IntegrityView ctx={ctx} />
          </Route>
          {!portal && (
            <Route path="/streams">
              <StreamsView ctx={ctx} />
            </Route>
          )}
          <Route>
            {/* Wait for /config: the bootstrap cannot know a token's portal principal, and
                mounting the overview first would fire a request the portal is denied. */}
            {!shell.ready ? null : showOverview ? (
              <OverviewView ctx={ctx} />
            ) : (
              <EventsView ctx={ctx} />
            )}
          </Route>
        </Switch>
      )}
    </ShellFrame>
  );
}
