import { describe, expect, test } from "vitest";
import {
  createPortalToken,
  intersectActions,
  PORTAL_TOKEN_PREFIX,
  portalCanSee,
  PortalTokenError,
  scopeQueryToPortal,
  verifyPortalToken,
} from "../src/portal.ts";
import type { AuditEvent } from "../src/schema.ts";

const SECRET = "an-arbitrary-portal-secret";

const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Craft a correctly signed token over an arbitrary payload string. */
async function craftToken(secret: string, payload: string): Promise<string> {
  const payloadPart = b64url(new TextEncoder().encode(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart)),
  );
  return `${PORTAL_TOKEN_PREFIX}${payloadPart}.${b64url(digest)}`;
}

const claimsOf = (token: string) => {
  const payloadPart = token.slice(PORTAL_TOKEN_PREFIX.length).split(".")[0]!;
  const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)));
};

describe("createPortalToken / verifyPortalToken", () => {
  test("round-trips the tenant", async () => {
    const token = await createPortalToken(SECRET, "acme");
    expect(token.startsWith("audpt_")).toBe(true);
    const grant = await verifyPortalToken(SECRET, token);
    expect(grant.tenant).toBe("acme");
    expect(grant.filter).toBeUndefined();
  });

  test("defaults expiry to 1 hour", async () => {
    const before = Date.now();
    const token = await createPortalToken(SECRET, "acme");
    const claims = claimsOf(token);
    expect(claims.tenant).toBe("acme");
    expect(claims.exp).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  test("honors a custom expiresIn duration", async () => {
    const before = Date.now();
    const token = await createPortalToken(SECRET, "acme", { expiresIn: "7d" });
    expect(claimsOf(token).exp).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
  });

  test("carries a cleaned filter", async () => {
    const token = await createPortalToken(SECRET, "acme", {
      filter: { excludeActions: ["support.*"], actorId: "u1", actions: [], targetId: "" },
    });
    const grant = await verifyPortalToken(SECRET, token);
    expect(grant.filter).toEqual({ excludeActions: ["support.*"], actorId: "u1" });
  });

  test("an empty filter is dropped", async () => {
    const token = await createPortalToken(SECRET, "acme", { filter: {} });
    expect(claimsOf(token).filter).toBeUndefined();
  });

  test("rejects an empty secret on create and on verify", async () => {
    await expect(createPortalToken("", "acme")).rejects.toThrow();
    const token = await createPortalToken(SECRET, "acme");
    await expect(verifyPortalToken("", token)).rejects.toThrow();
  });

  test("verifies with any secret of a rotation list; the first one signs", async () => {
    const old = await createPortalToken("old-secret", "acme");
    expect((await verifyPortalToken(["new-secret", "old-secret"], old)).tenant).toBe("acme");
    const fresh = await createPortalToken(["new-secret", "old-secret"], "acme");
    expect((await verifyPortalToken("new-secret", fresh)).tenant).toBe("acme");
  });

  test("a token in the v0.1.x field order ({ tenant, exp, filter }) verifies", async () => {
    const exp = Date.now() + 60_000;
    const token = await craftToken(
      SECRET,
      JSON.stringify({ tenant: "acme", exp, filter: { actorId: "u_1" } }),
    );
    expect(await verifyPortalToken(SECRET, token)).toEqual({
      tenant: "acme",
      expiresAt: exp,
      filter: { actorId: "u_1" },
    });
  });

  test("requires a tenant", async () => {
    await expect(createPortalToken(SECRET, "")).rejects.toThrow(TypeError);
  });

  test("rejects a wrong secret", async () => {
    const token = await createPortalToken(SECRET, "acme");
    await expect(verifyPortalToken("other", token)).rejects.toThrow(/signature mismatch/);
  });

  test("rejects a tampered payload", async () => {
    const token = await createPortalToken(SECRET, "acme");
    const [, sig] = token.slice(PORTAL_TOKEN_PREFIX.length).split(".");
    const forged = `${PORTAL_TOKEN_PREFIX}${b64url(new TextEncoder().encode(JSON.stringify({ tenant: "evil", exp: Date.now() + 1e6 })))}.${sig}`;
    await expect(verifyPortalToken(SECRET, forged)).rejects.toBeInstanceOf(PortalTokenError);
  });

  test("rejects an expired token", async () => {
    const token = await craftToken(SECRET, JSON.stringify({ tenant: "acme", exp: Date.now() - 1 }));
    await expect(verifyPortalToken(SECRET, token)).rejects.toThrow(/expired/);
  });

  test.each([
    ["missing prefix", "nope.abc"],
    ["no separator", `${PORTAL_TOKEN_PREFIX}abc`],
    ["empty parts", `${PORTAL_TOKEN_PREFIX}.`],
    ["bad signature encoding", `${PORTAL_TOKEN_PREFIX}abc.!!!`],
  ])("rejects a malformed token (%s)", async (_label, token) => {
    await expect(verifyPortalToken(SECRET, token)).rejects.toBeInstanceOf(PortalTokenError);
  });

  test.each([
    ["non-JSON payload", "not json"],
    ["missing tenant", JSON.stringify({ exp: Date.now() + 1e6 })],
    ["missing expiry", JSON.stringify({ tenant: "acme" })],
  ])("rejects signed but invalid claims (%s)", async (_label, payload) => {
    const token = await craftToken(SECRET, payload);
    await expect(verifyPortalToken(SECRET, token)).rejects.toBeInstanceOf(PortalTokenError);
  });
});

describe("intersectActions", () => {
  test("exact ∩ exact", () => {
    expect(intersectActions(["a.b", "c.d"], ["a.b"])).toEqual(["a.b"]);
    expect(intersectActions(["a.b"], ["c.d"])).toEqual([]);
  });

  test("family ∩ exact keeps the exact names inside the family", () => {
    expect(intersectActions(["invoice.*"], ["invoice.paid", "user.login"])).toEqual([
      "invoice.paid",
    ]);
    expect(intersectActions(["invoice.paid"], ["invoice.*"])).toEqual(["invoice.paid"]);
  });

  test("nested families keep the narrower one", () => {
    expect(intersectActions(["invoice.*"], ["invoice.refund.*"])).toEqual(["invoice.refund.*"]);
    expect(intersectActions(["*"], ["a.*", "b.c"])).toEqual(["a.*", "b.c"]);
  });
});

describe("scopeQueryToPortal", () => {
  const grant = { tenant: "acme", expiresAt: Date.now() + 1e6 };

  test("forces the tenant; a different client tenant is empty", () => {
    expect(scopeQueryToPortal({}, grant)).toEqual({ query: { tenant: "acme" }, empty: false });
    expect(scopeQueryToPortal({ tenant: "other" }, grant).empty).toBe(true);
  });

  test("intersects action lists (narrow, never widen)", () => {
    const g = { ...grant, filter: { actions: ["invoice.*"] } };
    expect(scopeQueryToPortal({}, g).query.actions).toEqual(["invoice.*"]);
    expect(scopeQueryToPortal({ actions: ["invoice.paid"] }, g).query.actions).toEqual([
      "invoice.paid",
    ]);
    const outside = scopeQueryToPortal({ actions: ["user.*"] }, g);
    expect(outside.empty).toBe(true);
    expect(outside.query.actions).toEqual(["invoice.*"]);
  });

  test("unions exclusions", () => {
    const g = { ...grant, filter: { excludeActions: ["support.*"] } };
    expect(scopeQueryToPortal({ excludeActions: ["x"] }, g).query.excludeActions).toEqual([
      "x",
      "support.*",
    ]);
  });

  test("forces actor/target; a different client value is empty", () => {
    const g = { ...grant, filter: { actorId: "u1", targetType: "invoice" } };
    expect(scopeQueryToPortal({ actorId: "u1" }, g)).toEqual({
      query: { tenant: "acme", actorId: "u1", targetType: "invoice" },
      empty: false,
    });
    expect(scopeQueryToPortal({ actorId: "u2" }, g).empty).toBe(true);
    expect(scopeQueryToPortal({ targetType: "user" }, g).empty).toBe(true);
  });

  test("portalCanSee applies tenant and filter", () => {
    const event = {
      tenant: "acme",
      action: "support.impersonate",
      actor: { id: "staff" },
      targets: [],
      occurredAt: "2026-01-01T00:00:00.000Z",
    } as unknown as AuditEvent;
    expect(portalCanSee(event, grant)).toBe(true);
    expect(portalCanSee({ ...event, tenant: "other" }, grant)).toBe(false);
    expect(portalCanSee(event, { ...grant, filter: { excludeActions: ["support.*"] } })).toBe(
      false,
    );
  });
});
