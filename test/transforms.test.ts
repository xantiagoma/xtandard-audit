import { describe, expect, it } from "vitest";
import {
  REDACTED,
  applyTransforms,
  hashValue,
  mask,
  maskValue,
  omit,
  redact,
  type TransformableEvent,
} from "../src/transforms.ts";

const event = (): TransformableEvent => ({
  id: "evt_1",
  tenant: "t",
  action: "x",
  occurredAt: "2026-01-01T00:00:00.000Z",
  actor: { id: "u", email: "ada@example.com" },
  targets: [
    { type: "user", id: "1", name: "Grace" },
    { type: "user", id: "2", name: "Alan" },
  ],
  context: { ip: "10.1.2.3" },
  metadata: { password: "hunter2", nested: { token: "t0k3n" }, keep: 1, list: ["a", "b"] },
});

describe("transforms", () => {
  it("redact / omit / mask with dotted paths and wildcards", async () => {
    const out = await applyTransforms(event(), [
      redact("metadata.password", "metadata.nested.token", "metadata.missing"),
      omit("context.ip", "metadata.list.0"),
      mask("actor.email", "targets.*.name"),
    ]);
    expect(out.metadata).toEqual({
      password: REDACTED,
      nested: { token: REDACTED },
      keep: 1,
      list: ["b"],
    });
    expect(out.context).toEqual({});
    expect(out.actor.email).toBe("a***@e***.com");
    expect(out.targets.map((t) => t.name)).toEqual(["*race", "****"]);
  });

  it("never mutates the input", async () => {
    const input = event();
    await redact("metadata.password")(input);
    expect(input.metadata.password).toBe("hunter2");
  });

  it("hashValue is deterministic and salted", async () => {
    const [a] = [await hashValue("context.ip")(event())];
    const b = await hashValue(["context.ip"], { salt: "pepper" })(event());
    expect(a.context.ip).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.context.ip).not.toBe(a.context.ip);
    expect((await hashValue("metadata.nested")(event())).metadata.nested).toMatch(/^sha256:/);
  });

  it("maskValue shapes", () => {
    expect(maskValue("abc")).toBe("****");
    expect(maskValue("4111111111111111")).toBe("************1111");
    expect(maskValue("x@y")).toBe("x***@y***");
  });
});
