import { describe, expect, it } from "vitest";
import {
  actorLabel,
  anchorLabel,
  can,
  erasedSections,
  exportFileName,
  formatCount,
  formatDateTime,
  groupActions,
  isEditableAction,
  isErasedValue,
  outcomeTone,
  overallStreamHealth,
  relativeTime,
  shortHash,
  streamHealth,
  targetsSummary,
  truncate,
  verificationSummary,
} from "../src/ui/lib/format.ts";
import {
  actionFamilies,
  actionSuggestions,
  activeFilterCount,
  EMPTY_FILTERS,
  filtersFromSearch,
  filtersToSearch,
  isFamily,
  isoToLocalInput,
  localInputToIso,
  parseList,
  toApiQuery,
  type EventFilters,
} from "../src/ui/lib/filters.ts";
import type { AuditCheckpoint, StreamStatus, VerifyReport } from "../src/ui/types.ts";

const report = (over: Partial<VerifyReport> = {}): VerifyReport => ({
  ok: true,
  tenant: "acme",
  checked: 10,
  fromSeq: 1,
  toSeq: 10,
  headHash: "sha256:abc",
  anchor: "genesis",
  linksChecked: true,
  checkpointsVerified: 1,
  signedThrough: 10,
  erased: [],
  issues: [],
  ...over,
});

const checkpoint = (over: Partial<AuditCheckpoint> = {}): AuditCheckpoint => ({
  v: 1,
  id: "chk_1",
  tenant: "acme",
  kind: "head",
  seq: 10,
  hash: "sha256:abc",
  at: "2026-07-04T12:00:00.000Z",
  keyId: "key-2026",
  alg: "Ed25519",
  signature: "sig",
  ...over,
});

describe("formatDateTime", () => {
  it("formats an ISO timestamp", () => {
    const out = formatDateTime("2026-01-02T03:04:05.000Z");
    expect(out).toContain("2026");
    expect(out).not.toBe("—");
  });

  it("returns a dash for missing or invalid input", () => {
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-07-04T12:00:00.000Z");

  it("says just now within ten seconds", () => {
    expect(relativeTime("2026-07-04T11:59:55.000Z", now)).toBe("just now");
  });

  it("formats past times per unit", () => {
    expect(relativeTime("2026-07-04T11:59:30.000Z", now)).toBe("30s ago");
    expect(relativeTime("2026-07-04T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-07-04T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-07-01T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("formats future times with an in prefix", () => {
    expect(relativeTime("2026-07-04T12:05:00.000Z", now)).toBe("in 5m");
  });

  it("returns a dash for missing or invalid input", () => {
    expect(relativeTime(undefined, now)).toBe("—");
    expect(relativeTime("garbage", now)).toBe("—");
  });
});

describe("formatCount / truncate / shortHash", () => {
  it("formats counts with separators", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(undefined)).toBe("—");
  });

  it("truncates within the budget", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hello world", 6)).toBe("hello…");
  });

  it("shortens sha256 digests keeping the prefix", () => {
    expect(shortHash(`sha256:${"a".repeat(64)}`, 8)).toBe("sha256:aaaaaaaa…");
    expect(shortHash("sha256:abc", 8)).toBe("sha256:abc");
    expect(shortHash("deadbeefcafe", 4)).toBe("dead…");
    expect(shortHash(null)).toBe("—");
  });
});

describe("can", () => {
  it("allows everything without an allowed list", () => {
    expect(can({}, "event:erase")).toBe(true);
    expect(can(undefined, "event:erase")).toBe(true);
  });

  it("checks the allowed list", () => {
    const config = { allowed: ["event:read", "event:export"] };
    expect(can(config, "event:read")).toBe(true);
    expect(can(config, "event:erase")).toBe(false);
  });
});

describe("event helpers", () => {
  it("labels actors by name, email, then id", () => {
    expect(actorLabel({ id: "u1", name: "Alice", email: "a@x" })).toBe("Alice");
    expect(actorLabel({ id: "u1", email: "a@x" })).toBe("a@x");
    expect(actorLabel({ id: "u1" })).toBe("u1");
    expect(actorLabel(undefined)).toBe("—");
    expect(actorLabel({ $erased: true } as never)).toBe("—");
  });

  it("summarizes targets", () => {
    expect(targetsSummary([])).toBe("—");
    expect(targetsSummary([{ type: "invoice", id: "inv_1" }])).toBe("invoice inv_1");
    expect(
      targetsSummary([
        { type: "invoice", id: "inv_1", name: "INV-001" },
        { type: "user", id: "u1" },
        { type: "team", id: "t1" },
      ]),
    ).toBe("invoice INV-001 +2");
    expect(targetsSummary({ $erased: true } as never)).toBe("—");
  });

  it("detects the erasure marker", () => {
    expect(isErasedValue({ $erased: true })).toBe(true);
    expect(isErasedValue({ $erased: false })).toBe(false);
    expect(isErasedValue([])).toBe(false);
    expect(isErasedValue(null)).toBe(false);
  });

  it("reads erased sections from the integrity block", () => {
    expect(erasedSections({ integrity: { erased: ["actor"] } as never })).toEqual(["actor"]);
    expect(erasedSections({ integrity: {} as never })).toEqual([]);
  });

  it("maps outcomes to distinct tones", () => {
    const tones = new Set([outcomeTone("success"), outcomeTone("failure"), outcomeTone(undefined)]);
    expect(tones.size).toBe(3);
    expect(outcomeTone("failure")).toContain("destructive");
  });
});

describe("groupActions", () => {
  it("groups by group, sorted, ungrouped last", () => {
    const groups = groupActions([
      { name: "user.created", group: "Users" },
      { name: "invoice.paid", group: "Billing" },
      { name: "ping" },
      { name: "invoice.voided", group: "Billing" },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["Billing", "Users", "Ungrouped"]);
    expect(groups[0]?.actions.map((a) => a.name)).toEqual(["invoice.paid", "invoice.voided"]);
  });

  it("only UI-sourced entries are editable", () => {
    expect(isEditableAction({ name: "a", source: "code" })).toBe(false);
    expect(isEditableAction({ name: "a", source: "ui" })).toBe(true);
    expect(isEditableAction({ name: "a" })).toBe(true);
  });
});

describe("stream health", () => {
  it("ranks failing over lagging over healthy", () => {
    expect(streamHealth({ lag: 0, failures: 0 })).toBe("healthy");
    expect(streamHealth({ lag: 5, failures: 0 })).toBe("lagging");
    expect(streamHealth({ lag: 5, failures: 2 })).toBe("failing");
  });

  it("takes the worst across streams", () => {
    const row = (lag: number, failures: number) => ({
      tenant: "t",
      cursor: 0,
      headSeq: lag,
      lag,
      failures,
    });
    const s = (rows: ReturnType<typeof row>[]): StreamStatus => ({
      name: "s",
      kind: "http",
      tenants: rows,
    });
    expect(overallStreamHealth([])).toBe("healthy");
    expect(overallStreamHealth([s([row(0, 0)]), s([row(3, 0)])])).toBe("lagging");
    expect(overallStreamHealth([s([row(3, 0)]), s([row(0, 1)])])).toBe("failing");
  });
});

describe("verificationSummary", () => {
  it("names the signing key and the signed range", () => {
    const s = verificationSummary(report(), [checkpoint()]);
    expect(s.tone).toBe("ok");
    expect(s.title).toBe("Verified through #10");
    expect(s.detail).toBe("Signed by key key-2026");
    expect(s.keyId).toBe("key-2026");
  });

  it("mentions the unsigned tail", () => {
    const s = verificationSummary(report({ toSeq: 14, signedThrough: 10 }), [checkpoint()]);
    expect(s.detail).toContain("#11–#14 intact, not yet signed");
  });

  it("picks the latest checkpoint at the signed seq", () => {
    const s = verificationSummary(report(), [
      checkpoint({ keyId: "old", at: "2026-01-01T00:00:00.000Z" }),
      checkpoint({ keyId: "new", at: "2026-02-01T00:00:00.000Z" }),
      checkpoint({ keyId: "other-seq", seq: 5, at: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(s.keyId).toBe("new");
  });

  it("warns when nothing is signed yet", () => {
    const s = verificationSummary(report({ signedThrough: null }));
    expect(s.tone).toBe("warn");
    expect(s.title).toBe("Chain intact through #10");
  });

  it("fails with the issue count", () => {
    const s = verificationSummary(
      report({
        ok: false,
        issues: [
          { kind: "hash-mismatch", seq: 3, message: "hash mismatch at #3" },
          { kind: "link-mismatch", seq: 4, message: "x" },
        ],
      }),
    );
    expect(s.tone).toBe("fail");
    expect(s.title).toBe("Verification failed: 2 issues found");
    expect(s.detail).toBe("hash mismatch at #3");
  });

  it("handles an empty log", () => {
    const s = verificationSummary(report({ checked: 0, fromSeq: null, toSeq: null }));
    expect(s.title).toBe("No events to verify");
  });

  it("labels anchors", () => {
    expect(anchorLabel("checkpoint")).toBe("Signed checkpoint");
    expect(anchorLabel("unanchored")).toBe("Unanchored");
  });
});

describe("exportFileName", () => {
  it("uses the content-disposition filename", () => {
    expect(exportFileName("acme", "csv", 'attachment; filename="acme-2026.csv"')).toBe(
      "acme-2026.csv",
    );
    expect(exportFileName("acme", "csv", "attachment; filename*=UTF-8''a%20b.csv")).toBe("a b.csv");
  });

  it("falls back to audit-<tenant>.<ext>", () => {
    expect(exportFileName("acme", "jsonl")).toBe("audit-acme.jsonl");
    expect(exportFileName("acme", "bundle", null)).toBe("audit-acme.bundle.json");
    expect(exportFileName("a/b c", "json")).toBe("audit-a_b_c.json");
  });
});

describe("filters ⇄ URL", () => {
  const full: EventFilters = {
    actions: ["invoice.*", "user.login"],
    actorId: "u_1",
    actorType: "user",
    targetType: "invoice",
    targetId: "inv_1",
    outcome: "failure",
    range: "custom",
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-02T00:00:00.000Z",
    search: "refund",
  };

  it("round-trips every field", () => {
    expect(filtersFromSearch(filtersToSearch(full))).toEqual(full);
  });

  it("keeps foreign params and drops defaults", () => {
    const base = new URLSearchParams("tenant=acme&event=evt_1&q=old&outcome=success");
    const out = filtersToSearch({ ...EMPTY_FILTERS, actorId: "u_2" }, base);
    expect(out.get("tenant")).toBe("acme");
    expect(out.get("event")).toBe("evt_1");
    expect(out.get("actor")).toBe("u_2");
    expect(out.has("q")).toBe(false);
    expect(out.has("outcome")).toBe(false);
    expect(out.has("range")).toBe(false);
  });

  it("drops from/to unless the range is custom", () => {
    const out = filtersToSearch({ ...full, range: "24h" });
    expect(out.get("range")).toBe("24h");
    expect(out.has("from")).toBe(false);
  });

  it("parses repeated and comma lists", () => {
    const f = filtersFromSearch(new URLSearchParams("actions=a,b&actions=c&actions=a"));
    expect(f.actions).toEqual(["a", "b", "c"]);
    expect(parseList([" x , ,y"])).toEqual(["x", "y"]);
  });

  it("sanitizes invalid values", () => {
    const f = filtersFromSearch(new URLSearchParams("outcome=maybe&range=forever"));
    expect(f.outcome).toBe("");
    expect(f.range).toBe("all");
  });

  it("infers a custom range from a bare from/to", () => {
    expect(filtersFromSearch(new URLSearchParams("from=2026-01-01T00:00:00Z")).range).toBe(
      "custom",
    );
  });

  it("counts active filters", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount(full)).toBe(8);
    expect(activeFilterCount({ ...EMPTY_FILTERS, range: "custom" })).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, range: "7d", search: " " })).toBe(1);
  });
});

describe("toApiQuery", () => {
  const now = Date.parse("2026-07-04T12:00:00.000Z");

  it("maps filters to the HTTP API parameters", () => {
    expect(
      toApiQuery(
        {
          ...EMPTY_FILTERS,
          actions: ["invoice.*", "user.login"],
          actorId: " u_1 ",
          outcome: "success",
          search: "refund",
        },
        now,
      ),
    ).toEqual({
      actions: "invoice.*,user.login",
      actorId: "u_1",
      outcome: "success",
      search: "refund",
    });
  });

  it("resolves presets against now", () => {
    expect(toApiQuery({ ...EMPTY_FILTERS, range: "24h" }, now)).toEqual({
      from: "2026-07-03T12:00:00.000Z",
    });
    expect(toApiQuery({ ...EMPTY_FILTERS, range: "15m" }, now).from).toBe(
      "2026-07-04T11:45:00.000Z",
    );
  });

  it("passes a custom range through", () => {
    expect(toApiQuery({ ...EMPTY_FILTERS, range: "custom", from: "a", to: "b" }, now)).toEqual({
      from: "a",
      to: "b",
    });
  });

  it("is empty for no filters", () => {
    expect(toApiQuery(EMPTY_FILTERS, now)).toEqual({});
  });
});

describe("datetime-local conversion", () => {
  it("round-trips through local time", () => {
    const iso = "2026-07-04T12:34:00.000Z";
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  });

  it("handles empty and invalid input", () => {
    expect(isoToLocalInput("")).toBe("");
    expect(isoToLocalInput("nope")).toBe("");
    expect(localInputToIso("")).toBe("");
    expect(localInputToIso("nope")).toBe("");
  });
});

describe("action autocomplete", () => {
  const names = ["invoice.paid", "invoice.voided", "billing.plan.changed", "user.login"];

  it("derives families at every level", () => {
    expect(actionFamilies(names)).toEqual(["billing.*", "billing.plan.*", "invoice.*", "user.*"]);
    expect(actionFamilies(["ping"])).toEqual([]);
  });

  it("recognizes family patterns", () => {
    expect(isFamily("invoice.*")).toBe(true);
    expect(isFamily("invoice.paid")).toBe(false);
  });

  it("lists families first with empty input, minus selected", () => {
    const out = actionSuggestions(names, "", ["invoice.*"]);
    expect(out[0]).toBe("billing.*");
    expect(out).not.toContain("invoice.*");
    expect(out).toContain("invoice.paid");
  });

  it("ranks prefix matches before substring matches", () => {
    expect(actionSuggestions(names, "inv")).toEqual([
      "invoice.*",
      "invoice.paid",
      "invoice.voided",
    ]);
    expect(actionSuggestions(names, "PAID")).toEqual(["invoice.paid"]);
    expect(actionSuggestions(names, "plan")).toEqual(["billing.plan.*", "billing.plan.changed"]);
  });

  it("respects the limit", () => {
    expect(actionSuggestions(names, "", [], 2)).toHaveLength(2);
  });
});
