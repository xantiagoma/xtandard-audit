import { describe, expect, it } from "vitest";
import {
  QueryError,
  actionMatches,
  applyQuery,
  decodeCursor,
  encodeCursor,
  normalizeQuery,
  toPage,
} from "../src/query.ts";
import { idPattern, idTime, newId, sortableId } from "../src/id.ts";
import type { AuditEvent } from "../src/schema.ts";

describe("normalizeQuery", () => {
  it("defaults, splits action families and lower-cases search", () => {
    const q = normalizeQuery({
      actions: ["invoice.*", "user.login", " ", "*"],
      excludeActions: ["user.secret*"],
      search: "  ADA ",
    });
    expect(q).toMatchObject({
      actions: ["user.login"],
      actionPrefixes: ["invoice.", ""],
      excludeActionPrefixes: ["user.secret"],
      search: "ada",
      order: "desc",
      limit: 50,
    });
  });

  it("clamps the limit and normalizes timestamps", () => {
    expect(normalizeQuery({ limit: 10_000 }).limit).toBe(500);
    expect(normalizeQuery({ limit: 7.9 }).limit).toBe(7);
    expect(normalizeQuery({ from: "2026-01-01" }).from).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects invalid input with QueryError", () => {
    expect(() => normalizeQuery({ limit: 0 })).toThrow(QueryError);
    expect(() => normalizeQuery({ order: "up" as never })).toThrow(QueryError);
    expect(() => normalizeQuery({ outcome: "maybe" as never })).toThrow(QueryError);
    expect(() => normalizeQuery({ from: "yesterday" })).toThrow(/Invalid from/);
    expect(() => normalizeQuery({ cursor: "garbage!" })).toThrow(/Invalid cursor/);
    expect(() => decodeCursor(encodeCursor({ occurredAt: "a", id: "b" }).slice(2))).toThrow(
      QueryError,
    );
  });

  it("cursors round-trip opaquely", () => {
    const c = encodeCursor({ occurredAt: "2026-01-01T00:00:00.000Z", id: "evt_1" });
    expect(c).not.toContain("evt_1");
    expect(decodeCursor(c)).toEqual({ occurredAt: "2026-01-01T00:00:00.000Z", id: "evt_1" });
  });
});

describe("matching", () => {
  it("action include/exclude semantics", () => {
    const q = normalizeQuery({ actions: ["invoice.*"], excludeActions: ["invoice.draft"] });
    expect(actionMatches("invoice.paid", q)).toBe(true);
    expect(actionMatches("invoice.draft", q)).toBe(false);
    expect(actionMatches("user.login", q)).toBe(false);
    expect(actionMatches("anything", normalizeQuery({}))).toBe(true);
  });

  it("applyQuery sorts, pages and builds the envelope", () => {
    const ev = (id: string, occurredAt: string) =>
      ({
        id,
        occurredAt,
        tenant: "t",
        action: "x",
        actor: { id: "u" },
        targets: [],
        metadata: {},
      }) as unknown as AuditEvent;
    const events = [ev("b", "2026-01-02"), ev("a", "2026-01-02"), ev("c", "2026-01-01")];
    const first = applyQuery(events, normalizeQuery({ limit: 2 }));
    expect(first.items.map((e) => e.id)).toEqual(["b", "a"]);
    const page = toPage(first);
    expect(page.pageInfo.hasNextPage).toBe(true);
    const second = applyQuery(
      events,
      normalizeQuery({ limit: 2, cursor: page.pageInfo.endCursor! }),
    );
    expect(second).toEqual({ items: [events[2]], hasMore: false });
    expect(toPage(second).pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });
});

describe("ids", () => {
  it("are time-sortable, monotonic and decodable", () => {
    const ms = Date.parse("2026-05-01T00:00:00.000Z");
    const ids = Array.from({ length: 50 }, () => newId("evt", ms));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ids.every((id) => idPattern("evt").test(id))).toBe(true);
    expect(idTime(ids[0]!)).toBe(ms);
    expect(newId("evt", ms + 1) > ids[49]!).toBe(true);
    expect(idTime("evt_short")).toBeNull();
    expect(idTime("evt_!!!!!!!!!!AAAAAAAAAAAAAAAA")).toBeNull();
    // A clock going backwards still yields increasing ids.
    expect(sortableId(ms - 10_000) > ids[49]!.slice(4)).toBe(true);
  });
});
