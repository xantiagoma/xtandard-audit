import { describe, expect, test } from "vitest";
import { basicAuth, hashPassword } from "../src/auth/basic.ts";

describe("basicAuth (audit defaults)", () => {
  test("challenge() defaults the realm to xtandard-audit", () => {
    const auth = basicAuth({ users: [{ username: "admin", password: "secret" }] });
    const response = auth.challenge?.(new Request("http://x/"));
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toBe('Basic realm="xtandard-audit"');
  });

  test("an explicit realm wins", () => {
    const auth = basicAuth({
      users: [{ username: "admin", password: "secret" }],
      realm: "Audit Admin",
    });
    const response = auth.challenge?.(new Request("http://x/"));
    expect(response?.headers.get("WWW-Authenticate")).toBe('Basic realm="Audit Admin"');
  });

  test("authenticates with a hashed password and returns the principal", async () => {
    const auth = basicAuth({
      users: [{ username: "ops", passwordHash: await hashPassword("s3cret"), roles: ["auditor"] }],
    });
    const request = new Request("http://x/", {
      headers: { authorization: `Basic ${btoa("ops:s3cret")}` },
    });
    expect(await auth.authenticate(request)).toMatchObject({ id: "ops", roles: ["auditor"] });
  });
});
