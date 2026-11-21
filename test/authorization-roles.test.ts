import { describe, expect, test } from "vitest";
import type { Principal } from "../src/auth/contract.ts";
import type { AuthorizeInput, AuditAction, AuditResource } from "../src/authorization/contract.ts";
import { isMutatingAction, MUTATING_ACTIONS } from "../src/authorization/contract.ts";
import {
  ALL_ACTIONS,
  AUDITOR_ACTIONS,
  DEFAULT_ROLE_POLICY,
  READ_ACTIONS,
  rolesAuthorization,
} from "../src/authorization/roles.ts";

const RESOURCE: AuditResource = { type: "event", tenant: "acme" };

const input = (
  principal: Principal | null,
  action: AuditAction,
  resource: AuditResource = RESOURCE,
): AuthorizeInput => ({
  principal,
  action,
  resource,
  request: new Request("http://x/"),
});

const admin: Principal = { id: "a", roles: ["admin"] };
const viewer: Principal = { id: "v", roles: ["viewer"] };
const auditor: Principal = { id: "au", roles: ["auditor"] };

describe("rolesAuthorization (default policy)", () => {
  const authz = rolesAuthorization();

  test("admin is allowed everything", async () => {
    for (const action of ALL_ACTIONS) {
      expect(await authz.authorize(input(admin, action))).toBe(true);
    }
  });

  test("viewer is allowed reads only", async () => {
    for (const action of READ_ACTIONS) {
      expect(await authz.authorize(input(viewer, action))).toBe(true);
    }
    expect(await authz.authorize(input(viewer, "event:export"))).toBe(false);
    expect(await authz.authorize(input(viewer, "event:erase"))).toBe(false);
    expect(await authz.authorize(input(viewer, "event:record"))).toBe(false);
    expect(await authz.authorize(input(viewer, "stream:retry"))).toBe(false);
  });

  test("auditor reads, exports and checkpoints — but never erases or prunes", async () => {
    for (const action of AUDITOR_ACTIONS) {
      expect(await authz.authorize(input(auditor, action))).toBe(true);
    }
    expect(await authz.authorize(input(auditor, "event:export"))).toBe(true);
    expect(await authz.authorize(input(auditor, "integrity:checkpoint"))).toBe(true);
    expect(await authz.authorize(input(auditor, "event:erase"))).toBe(false);
    expect(await authz.authorize(input(auditor, "retention:prune"))).toBe(false);
    expect(await authz.authorize(input(auditor, "action:delete"))).toBe(false);
  });

  test("null principal is denied", async () => {
    expect(await authz.authorize(input(null, "event:read"))).toBe(false);
  });

  test("principal with no matching role is denied", async () => {
    expect(await authz.authorize(input({ id: "x", roles: ["nobody"] }, "event:read"))).toBe(false);
    expect(await authz.authorize(input({ id: "x" }, "event:read"))).toBe(false);
  });
});

describe("rolesAuthorization (readonly)", () => {
  const authz = rolesAuthorization({ readonly: true });

  test("blocks mutating actions even for admin", async () => {
    expect(await authz.authorize(input(admin, "event:erase"))).toBe(false);
    expect(await authz.authorize(input(admin, "event:record"))).toBe(false);
    expect(await authz.authorize(input(admin, "retention:prune"))).toBe(false);
  });

  test("still allows reads and exports for authorized roles", async () => {
    expect(await authz.authorize(input(admin, "event:read"))).toBe(true);
    expect(await authz.authorize(input(viewer, "integrity:read"))).toBe(true);
    // export does not mutate the log — readonly leaves it to the role policy.
    expect(await authz.authorize(input(auditor, "event:export"))).toBe(true);
  });
});

describe("rolesAuthorization (custom policy)", () => {
  test("honors an explicit action list", async () => {
    const authz = rolesAuthorization({
      policy: { compliance: ["event:read", "event:erase"] },
    });
    const c: Principal = { id: "c", roles: ["compliance"] };
    expect(await authz.authorize(input(c, "event:erase"))).toBe(true);
    expect(await authz.authorize(input(c, "retention:prune"))).toBe(false);
  });

  test("DEFAULT_ROLE_POLICY exposes admin/auditor/viewer", () => {
    expect(DEFAULT_ROLE_POLICY.admin).toBe("*");
    expect(DEFAULT_ROLE_POLICY.auditor).toEqual([...AUDITOR_ACTIONS]);
    expect(DEFAULT_ROLE_POLICY.viewer).toEqual([...READ_ACTIONS]);
  });
});

describe("MUTATING_ACTIONS", () => {
  test("classifies reads and exports as non-mutating and writes as mutating", () => {
    expect(isMutatingAction("event:read")).toBe(false);
    expect(isMutatingAction("event:export")).toBe(false);
    expect(isMutatingAction("integrity:read")).toBe(false);
    expect(isMutatingAction("event:record")).toBe(true);
    expect(isMutatingAction("event:erase")).toBe(true);
    expect(isMutatingAction("integrity:checkpoint")).toBe(true);
    expect(isMutatingAction("stream:retry")).toBe(true);
    for (const action of MUTATING_ACTIONS) {
      expect(ALL_ACTIONS).toContain(action);
    }
  });
});
