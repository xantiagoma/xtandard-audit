import { describe, expect, it } from "vitest";
import {
  auditContextFromRequest,
  getAuditContext,
  runWithAuditContext,
  setAuditContext,
} from "../src/context.ts";

describe("audit context", () => {
  it("is null outside a scope; nested scopes merge", async () => {
    expect(getAuditContext()).toBeNull();
    await runWithAuditContext({ tenant: "a", context: { ip: "1" } }, async () => {
      await runWithAuditContext({ actor: { id: "u" }, context: { requestId: "r" } }, async () => {
        expect(getAuditContext()).toEqual({
          tenant: "a",
          actor: { id: "u" },
          context: { ip: "1", requestId: "r" },
        });
      });
      expect(getAuditContext()).toEqual({ tenant: "a", context: { ip: "1" } });
    });
  });

  it("setAuditContext patches the current async execution", async () => {
    await runWithAuditContext({ tenant: "a" }, async () => {
      setAuditContext({ actor: { id: "late" } });
      await Promise.resolve();
      expect(getAuditContext()).toMatchObject({ tenant: "a", actor: { id: "late" } });
    });
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        setAuditContext({ tenant: "fresh" });
        expect(getAuditContext()).toEqual({ tenant: "fresh" });
        resolve();
      }),
    );
  });

  it("extracts ip / user agent / request id from a Request", () => {
    const req = new Request("http://x", {
      headers: {
        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        "user-agent": "curl/8",
        "x-request-id": "req_1",
      },
    });
    expect(auditContextFromRequest(req)).toEqual({
      ip: "203.0.113.7",
      userAgent: "curl/8",
      requestId: "req_1",
    });
    expect(auditContextFromRequest(req, { trustProxy: false, ip: "127.0.0.1" }).ip).toBe(
      "127.0.0.1",
    );
    const cf = new Request("http://x", {
      headers: { "cf-connecting-ip": "1.2.3.4", "cf-ray": "ray", "x-trace": "t" },
    });
    expect(auditContextFromRequest(cf)).toEqual({ ip: "1.2.3.4", requestId: "ray" });
    expect(auditContextFromRequest(cf, { requestIdHeader: "x-trace" }).requestId).toBe("t");
  });
});
