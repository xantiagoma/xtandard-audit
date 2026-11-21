import { describe, expect, it } from "vitest";
import {
  AuditDashboard,
  AuditPortal,
  setApiBase,
  setApiToken,
  type AuditDashboardProps,
  type AuditPortalProps,
} from "../src/react.tsx";

// Smoke test for the `@xtandard/audit/react` embed entry: the module must
// import cleanly outside a DOM and export both components. No rendering here —
// everything visual is covered by e2e (see docs/TESTING.md policy).
describe("react embed", () => {
  it("exports AuditDashboard and AuditPortal as components", () => {
    expect(typeof AuditDashboard).toBe("function");
    expect(typeof AuditPortal).toBe("function");
  });

  it("exports the API client setters", () => {
    expect(typeof setApiBase).toBe("function");
    expect(typeof setApiToken).toBe("function");
  });

  it("prop types compile", () => {
    // Type-level usage only (never rendered): the dashboard accepts the full
    // prop surface, the portal requires `token` and rejects the admin-only
    // `initialTenant`.
    const dashboardProps: AuditDashboardProps = {
      apiBaseUrl: "/audit",
      credentials: "include",
      fetch: (input, init) => fetch(input, init),
      theme: "inherit",
      className: "embedded",
      routing: "memory",
      routerBase: "/admin/audit",
      logoUrl: "/logo.svg",
      initialTenant: "acme",
    };

    const portalProps: AuditPortalProps = {
      apiBaseUrl: "/audit",
      token: "audpt_example",
    };

    const invalidPortalProps: AuditPortalProps = {
      token: "audpt_example",
      // @ts-expect-error — the portal is pinned to the token's tenant.
      initialTenant: "acme",
    };

    // Minimal usage: everything on the dashboard is optional; the portal only
    // needs its token.
    const minimalDashboardProps: AuditDashboardProps = {};

    expect(dashboardProps.apiBaseUrl).toBe("/audit");
    expect(portalProps.token).toBe("audpt_example");
    expect(invalidPortalProps.token).toBe("audpt_example");
    expect(minimalDashboardProps).toEqual({});
  });
});
