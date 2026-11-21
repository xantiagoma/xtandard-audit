import React from "react";
import { Router, Switch, Route, useLocation, useSearchParams, type BaseLocationHook } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import type { AuditConfig, PanelAction } from "./types.ts";
import { getConfig, listTenants } from "./api.ts";
import { ThemeToggle } from "./components/ThemeToggle.tsx";
import { Dropdown } from "./components/primitives.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { EventsView } from "./views/EventsView.tsx";
import { TenantsView } from "./views/TenantsView.tsx";
import { ActionsView } from "./views/ActionsView.tsx";
import { IntegrityView } from "./views/IntegrityView.tsx";
import { StreamsView } from "./views/StreamsView.tsx";
import { can } from "./lib/format.ts";
import { cn } from "./lib/utils.ts";
import { canLeave } from "./lib/nav-guard.ts";
import symbolUrl from "./brand/symbol.svg";
import symbolLightUrl from "./brand/symbol-light.svg";

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

declare global {
  interface Window {
    __AUDIT_CONFIG__?: AuditConfig;
  }
}

function getBootstrap(): Partial<AuditConfig> {
  return (typeof window !== "undefined" && window.__AUDIT_CONFIG__) || {};
}

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
  base = "",
  logoUrl,
  initialTenant,
  showThemeToggle = true,
}: {
  locationHook?: BaseLocationHook;
  base?: string;
  /** Override the navbar logo image (otherwise taken from server `/config`). */
  logoUrl?: string;
  /** Pre-select a tenant when the URL doesn't name one (embed hosts). */
  initialTenant?: string;
  /** Show the system/light/dark switcher. Off when an embedding host owns the theme. */
  showThemeToggle?: boolean;
}): React.ReactElement {
  return (
    <Router hook={locationHook ?? useHashLocation} base={base}>
      <AppShell logoUrl={logoUrl} initialTenant={initialTenant} showThemeToggle={showThemeToggle} />
    </Router>
  );
}

function AppShell({
  logoUrl,
  initialTenant,
  showThemeToggle,
}: {
  logoUrl?: string;
  initialTenant?: string;
  showThemeToggle: boolean;
}) {
  const bootstrap = getBootstrap();

  const [location, navigate] = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    staleTime: 60_000,
  });

  const config: AuditConfig = configQuery.data ?? ({ ...bootstrap } as AuditConfig);
  const readonly = config.readonly ?? false;
  // Portal mode: the request is scoped by a portal token — reduced chrome, one
  // fixed tenant (reported by /config).
  const portal = config.portal ?? false;
  const allowed = (action: PanelAction) => can(config, action);

  // Branding: explicit props win, then server /config, then defaults.
  const brandTitle = config.title || "@xtandard/audit";
  const brandLogoUrl = logoUrl ?? config.logoUrl;

  const tenantsQuery = useQuery({
    queryKey: ["tenants"],
    queryFn: listTenants,
    staleTime: 30_000,
    enabled: configQuery.isSuccess && !portal && allowed("tenant:read"),
  });
  const tenants = tenantsQuery.data ?? [];

  // Tenant precedence: portal pins the token's tenant; otherwise the URL wins
  // (a shared link restores context; the switcher writes here), then the embed
  // host's initial prop, then "all tenants".
  const tenant = portal
    ? (config.tenant ?? "")
    : (searchParams.get("tenant") ?? initialTenant ?? "");

  // All in-app navigation funnels through these helpers, so they consult the nav
  // guard — a view with unsaved edits can veto the move (wouter has no built-in
  // blocker).
  const go = (path: string, params: Record<string, string> = {}) => {
    if (!canLeave()) return;
    const next = new URLSearchParams();
    for (const key of STICKY_PARAMS) {
      const value = searchParams.get(key);
      if (value) next.set(key, value);
    }
    for (const [key, value] of Object.entries(params)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const search = next.toString();
    navigate(search ? `${path}?${search}` : path);
  };

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
  const tabs = NAV_TABS.filter(
    (t) => (!portal || !t.adminOnly) && allowed(t.requires) && (!t.streams || streamsEnabled),
  );

  const ctx: ShellContext = { config, readonly, portal, tenant, setTenant, go, can: allowed };
  const showOverview = !portal && allowed("tenant:read");

  if (configQuery.isError && !bootstrap.title) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4 text-center">
        <p className="text-[13px] text-muted-foreground">
          Could not load the panel configuration. Check that the API is reachable and that you are
          signed in.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* ── Top Nav ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          {/* Brand: a configured logoUrl shows as the logo; otherwise the title
              wordmark. No default icon. */}
          <div className="flex items-center gap-2 shrink-0">
            {brandLogoUrl ? (
              <img
                src={brandLogoUrl}
                alt={brandTitle}
                className="h-7 max-w-[320px] object-contain"
              />
            ) : (
              <>
                {/* The bare symbol (SVG, no tile), in each theme's lime (docs/BRAND.md). */}
                <img src={symbolLightUrl} alt="" aria-hidden className="h-6 w-auto dark:hidden" />
                <img src={symbolUrl} alt="" aria-hidden className="hidden h-6 w-auto dark:block" />
                <span className="text-sm font-semibold tracking-tight">{brandTitle}</span>
              </>
            )}
          </div>

          {portal ? (
            // Portal chrome: no switcher — the token pins the tenant.
            tenant ? (
              <>
                <span className="text-border select-none">/</span>
                <span className="font-mono text-[13px] text-muted-foreground">{tenant}</span>
              </>
            ) : null
          ) : allowed("tenant:read") ? (
            <>
              <span className="text-border select-none">/</span>
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
            </>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {readonly && (
              <span className="flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                <Lock className="size-3" />
                Read-only
              </span>
            )}
            {portal && (
              <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                Portal
              </span>
            )}
            {showThemeToggle && <ThemeToggle />}
          </div>
        </div>

        {/* Nav tabs */}
        {tabs.length > 1 && (
          <nav
            className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-2 sm:px-4"
            aria-label="Main navigation"
          >
            {tabs.map(({ path, label, match }) => {
              // Without an Overview tab, "/" renders Events — highlight it.
              const active =
                match(location) || (!showOverview && location === "/" && path === "/events");
              return (
                <button
                  key={path}
                  onClick={() => go(path)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "whitespace-nowrap px-3 py-2.5 text-[13px] font-medium transition-colors",
                    active
                      ? "relative text-foreground after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </nav>
        )}
      </header>

      {/* ── Main content (routed) ────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        {configQuery.isLoading && !bootstrap.title ? null : (
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
              {/* Wait for /config: the bootstrap config cannot know a ?token= portal principal,
                  and mounting the overview first would fire a request the portal is denied. */}
              {!configQuery.isSuccess ? null : showOverview ? (
                <OverviewView ctx={ctx} />
              ) : (
                <EventsView ctx={ctx} />
              )}
            </Route>
          </Switch>
        )}
      </main>
    </div>
  );
}
