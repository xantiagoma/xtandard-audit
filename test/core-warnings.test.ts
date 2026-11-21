import { expect, it, vi } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

it("warns once when the storage cannot protect the chain against concurrent writers", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const m = createMemoryStorage();
  const plainKv = {
    getItem: m.getItem,
    setItem: m.setItem,
    removeItem: m.removeItem,
    getKeys: m.getKeys,
  };
  createAuditCore({ storage: createMemoryStorage() }); // native: no warning
  createAuditCore({ storage: { ...plainKv, compareAndSwap: m.compareAndSwap } }); // CAS: no warning
  expect(warn).not.toHaveBeenCalled();
  createAuditCore({ storage: plainKv });
  createAuditCore({ storage: plainKv });
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0]![0])).toMatch(/single writer per tenant/);
  warn.mockRestore();
});
