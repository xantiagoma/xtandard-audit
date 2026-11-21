import { describe, expect, it } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { createLogHook } from "../src/hooks/log.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

describe("createLogHook", () => {
  it("logs after events (and before events when asked)", async () => {
    const lines: string[] = [];
    const audit = createAuditCore({
      storage: createMemoryStorage(),
      hooks: createLogHook({ log: (l) => lines.push(l), includeBefore: true }),
    });
    await audit.record({ tenant: "t", action: "x", actor: { id: "u" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(lines.map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual([
      "[@xtandard/audit] before event.record",
      "[@xtandard/audit] after events.recorded",
    ]);
  });
});
