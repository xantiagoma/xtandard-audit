/**
 * Reusable conformance suite for the {@link AuditStorage} contract (ADR 0005).
 * Every storage adapter runs the same battery by calling
 * {@link runStorageContractTests}:
 *
 * 1. the four-method KV contract (round-trips, prefixes, ordering of padded keys);
 * 2. the **event log** through the core — record, query (every filter, keyset
 *    pagination in both orders), get, eventsBySeq, erase, prune, verify — which
 *    exercises the native `EventLogStorage` capability when the adapter has it
 *    and the generic KV fallback otherwise;
 * 3. native-only `EventLogStorage` semantics (append atomicity and
 *    `ChainConflictError`) when the adapter implements the capability.
 *
 * This file deliberately omits the `.test.ts` suffix so vitest does not pick it
 * up as a standalone suite — it only runs when imported by an adapter's test.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { createAuditCore } from "../src/core.ts";
import { hmacSigner, sealChain, GENESIS_HASH } from "../src/integrity.ts";
import { eventKey, padSeq } from "../src/keys.ts";
import { normalizeQuery } from "../src/query.ts";
import type { AuditEvent } from "../src/schema.ts";
import { ChainConflictError, hasEventLog, type AuditStorage } from "../src/storage/contract.ts";

/** A factory producing a fresh, empty storage for each test. */
export type MakeStorage = () => Promise<AuditStorage> | AuditStorage;

/** Optional extras a backend opts into. */
export interface StorageContractOptions {
  /** Assert the adapter implements the native event log (default: detect). */
  expectNativeEventLog?: boolean;
  /** Per-test timeout (remote backends). */
  timeout?: number;
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** Seed a realistic spread of events across two tenants. */
export async function seedEvents(storage: AuditStorage) {
  let clock = T0;
  const audit = createAuditCore({ storage, now: () => (clock += 1000), selfAudit: false });
  const rows = [
    {
      tenant: "acme",
      action: "user.login",
      actor: { id: "u_1", name: "Ada Lovelace" },
      occurredAt: at(1),
    },
    {
      tenant: "acme",
      action: "invoice.paid",
      actor: { id: "u_2", type: "api_key" },
      targets: [{ type: "invoice", id: "inv_1", name: "Invoice #1" }],
      metadata: { amount: 4200, currency: "EUR" },
      occurredAt: at(2),
    },
    {
      tenant: "acme",
      action: "invoice.refunded",
      actor: { id: "u_1", name: "Ada Lovelace" },
      targets: [{ type: "invoice", id: "inv_1" }],
      outcome: "failure" as const,
      description: "Refund rejected by the processor",
      occurredAt: at(3),
    },
    {
      tenant: "acme",
      action: "member.role_changed",
      actor: { id: "u_1", name: "Ada Lovelace" },
      targets: [
        { type: "user", id: "u_3", name: "Grace Hopper" },
        { type: "team", id: "team_1" },
      ],
      metadata: { from: "member", to: "admin" },
      outcome: "success" as const,
      occurredAt: at(4),
    },
    { tenant: "globex", action: "user.login", actor: { id: "g_1" }, occurredAt: at(2) },
    // Same occurredAt as a sibling: the id breaks the tie.
    { tenant: "acme", action: "user.logout", actor: { id: "u_1" }, occurredAt: at(4) },
  ];
  const recorded: AuditEvent[] = [];
  for (const r of rows) recorded.push(await audit.record(r));
  return { audit, recorded };
}

/**
 * Register a `describe(name, …)` block exercising the full storage contract.
 */
export function runStorageContractTests(
  name: string,
  makeStorage: MakeStorage,
  options: StorageContractOptions = {},
): void {
  const t = options.timeout;

  describe(`AuditStorage KV contract: ${name}`, () => {
    test("returns null for a missing key", { timeout: t }, async () => {
      const storage = await makeStorage();
      expect(await storage.getItem("aud/t/acme/missing")).toBeNull();
    });

    test("round-trips object and primitive values", { timeout: t }, async () => {
      const storage = await makeStorage();
      const value = { action: "invoice.paid", targets: ["a", "b"], nested: { x: 1 } };
      await storage.setItem("aud/actions/invoice.paid", value);
      await storage.setItem("aud/t/acme/ids/evt_1", 7);
      await storage.setItem("aud/x/str", "hello");
      expect(await storage.getItem("aud/actions/invoice.paid")).toEqual(value);
      expect(await storage.getItem("aud/t/acme/ids/evt_1")).toBe(7);
      expect(await storage.getItem("aud/x/str")).toBe("hello");
    });

    test("overwrites and removes", { timeout: t }, async () => {
      const storage = await makeStorage();
      await storage.setItem("aud/k", { v: 1 });
      await storage.setItem("aud/k", { v: 2 });
      expect(await storage.getItem("aud/k")).toEqual({ v: 2 });
      await storage.removeItem("aud/k");
      expect(await storage.getItem("aud/k")).toBeNull();
      await expect(storage.removeItem("aud/nope")).resolves.toBeUndefined();
    });

    test("getKeys lists nested keys under a prefix, isolated", { timeout: t }, async () => {
      const storage = await makeStorage();
      await storage.setItem("aud/t/acme/head", { seq: 1 });
      await storage.setItem("aud/t/acme/checkpoints/chk_1", { v: 1 });
      await storage.setItem("aud/t/acmeX/head", { seq: 2 });
      expect((await storage.getKeys("aud/t/acme/")).sort()).toEqual(
        ["aud/t/acme/checkpoints/chk_1", "aud/t/acme/head"].sort(),
      );
      expect(await storage.getKeys("aud/t/none/")).toEqual([]);
    });

    test("keys are case- and accent-exact", { timeout: t }, async () => {
      const storage = await makeStorage();
      // NFC "é" vs NFD "e\u0301" vs plain "e"; upper vs lower case.
      const keys = [
        "aud/t/Acme/k",
        "aud/t/acme/k",
        "aud/t/ACME/k",
        "aud/t/caf\u00e9/k",
        "aud/t/cafe\u0301/k",
        "aud/t/cafe/k",
      ];
      for (const [i, key] of keys.entries()) await storage.setItem(key, i);
      for (const [i, key] of keys.entries()) expect(await storage.getItem(key)).toBe(i);
      expect(await storage.getKeys("aud/t/acme/")).toEqual(["aud/t/acme/k"]);
      expect(await storage.getKeys("aud/t/Acme/")).toEqual(["aud/t/Acme/k"]);
      expect(await storage.getKeys("aud/t/cafe/")).toEqual(["aud/t/cafe/k"]);
      expect(await storage.getKeys("aud/t/caf\u00e9/")).toEqual(["aud/t/caf\u00e9/k"]);
      await storage.removeItem("aud/t/Acme/k");
      expect(await storage.getItem("aud/t/acme/k")).toBe(1);
    });

    test("prefixes are literal: % _ ! * [ ] ? \\ are not wildcards", { timeout: t }, async () => {
      const storage = await makeStorage();
      const specials = ["%", "_", "!", "*", "[", "]", "?", "\\"];
      for (const ch of specials) {
        await storage.setItem(`aud/w/a${ch}b/k`, ch);
        await storage.setItem(`aud/w/aXb/k${ch}`, ch);
      }
      for (const ch of specials) {
        expect(await storage.getKeys(`aud/w/a${ch}b/`)).toEqual([`aud/w/a${ch}b/k`]);
      }
      expect((await storage.getKeys("aud/w/aXb/")).length).toBe(specials.length);
    });

    test("zero-padded seq keys sort lexicographically = numerically", { timeout: t }, async () => {
      const storage = await makeStorage();
      for (const seq of [10, 2, 100, 1]) await storage.setItem(eventKey("acme", seq), { seq });
      const keys = (await storage.getKeys("aud/t/acme/events/")).sort();
      expect(keys.map((k) => k.slice(-12))).toEqual([1, 2, 10, 100].map(padSeq));
    });
  });

  describe(`AuditStorage event log: ${name}`, () => {
    if (options.expectNativeEventLog !== undefined) {
      test("native event-log capability matches expectation", { timeout: t }, async () => {
        expect(hasEventLog(await makeStorage())).toBe(options.expectNativeEventLog);
      });
    }

    test("record assigns contiguous seqs per tenant and chains them", { timeout: t }, async () => {
      const { audit, recorded } = await seedEvents(await makeStorage());
      const acme = recorded.filter((e) => e.tenant === "acme");
      expect(acme.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(acme[0]!.integrity.prevHash).toBe(GENESIS_HASH);
      for (let i = 1; i < acme.length; i++) {
        expect(acme[i]!.integrity.prevHash).toBe(acme[i - 1]!.integrity.hash);
      }
      expect(recorded.find((e) => e.tenant === "globex")!.seq).toBe(1);
      expect((await audit.head("acme")).seq).toBe(5);
      expect((await audit.verify("acme")).ok).toBe(true);
      expect((await audit.verify("globex")).ok).toBe(true);
    });

    test("tenants differing only in case are separate chains", { timeout: t }, async () => {
      const storage = await makeStorage();
      const audit = createAuditCore({ storage });
      await audit.record({ tenant: "Acme", action: "x.y", actor: { id: "1" } });
      await audit.record({ tenant: "acme", action: "x.y", actor: { id: "1" } });
      await audit.record({ tenant: "acme", action: "x.y", actor: { id: "1" } });
      expect((await audit.head("Acme")).seq).toBe(1);
      expect((await audit.head("acme")).seq).toBe(2);
      expect((await audit.query({ tenant: "Acme" })).items).toHaveLength(1);
      expect((await audit.verify("acme")).ok).toBe(true);
      expect((await audit.verify("Acme")).ok).toBe(true);
    });

    test("get returns stored events exactly; unknown ids are null", { timeout: t }, async () => {
      const { audit, recorded } = await seedEvents(await makeStorage());
      const e = recorded[3]!;
      expect(await audit.get("acme", e.id)).toEqual(e);
      expect(await audit.get("globex", e.id)).toBeNull();
      expect(await audit.get("acme", "evt_missing")).toBeNull();
    });

    test("query defaults to newest first by (occurredAt, id)", { timeout: t }, async () => {
      const { audit } = await seedEvents(await makeStorage());
      const page = await audit.query({ tenant: "acme" });
      const actions = page.items.map((e) => e.action);
      expect(actions[0]).toBe("user.logout"); // same minute as role_changed, later id
      expect(actions).toEqual([
        "user.logout",
        "member.role_changed",
        "invoice.refunded",
        "invoice.paid",
        "user.login",
      ]);
      expect(page.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    });

    test("query filters: actions, families, excludes", { timeout: t }, async () => {
      const { audit } = await seedEvents(await makeStorage());
      const q = async (query: Parameters<typeof audit.query>[0]) =>
        (await audit.query({ tenant: "acme", ...query })).items.map((e) => e.action).sort();
      expect(await q({ actions: ["invoice.paid"] })).toEqual(["invoice.paid"]);
      expect(await q({ actions: ["invoice.*"] })).toEqual(["invoice.paid", "invoice.refunded"]);
      expect(await q({ actions: ["invoice.*", "user.login"] })).toEqual([
        "invoice.paid",
        "invoice.refunded",
        "user.login",
      ]);
      expect(await q({ excludeActions: ["user.*"] })).toEqual([
        "invoice.paid",
        "invoice.refunded",
        "member.role_changed",
      ]);
    });

    test("query filters: actor, target, outcome, time range, search", { timeout: t }, async () => {
      const { audit } = await seedEvents(await makeStorage());
      const q = async (query: Parameters<typeof audit.query>[0]) =>
        (await audit.query({ tenant: "acme", ...query })).items.map((e) => e.action).sort();
      expect(await q({ actorId: "u_2" })).toEqual(["invoice.paid"]);
      expect(await q({ actorType: "api_key" })).toEqual(["invoice.paid"]);
      expect((await q({ actorType: "user" })).length).toBe(4);
      expect(await q({ targetType: "invoice", targetId: "inv_1" })).toEqual([
        "invoice.paid",
        "invoice.refunded",
      ]);
      expect(await q({ targetType: "team" })).toEqual(["member.role_changed"]);
      expect(await q({ targetId: "u_3" })).toEqual(["member.role_changed"]);
      expect(await q({ outcome: "failure" })).toEqual(["invoice.refunded"]);
      expect(await q({ from: at(2), to: at(4) })).toEqual(["invoice.paid", "invoice.refunded"]);
      expect(await q({ search: "grace" })).toEqual(["member.role_changed"]);
      expect(await q({ search: "EUR" })).toEqual(["invoice.paid"]);
      expect(await q({ search: "processor" })).toEqual(["invoice.refunded"]);
      expect(await q({ actorId: "u_1", actions: ["invoice.*"] })).toEqual(["invoice.refunded"]);
    });

    test("query across tenants when tenant is omitted", { timeout: t }, async () => {
      const { audit } = await seedEvents(await makeStorage());
      const page = await audit.query({ actions: ["user.login"] });
      expect(page.items.map((e) => e.tenant).sort()).toEqual(["acme", "globex"]);
    });

    test("keyset pagination is complete and stable in both orders", { timeout: t }, async () => {
      const { audit } = await seedEvents(await makeStorage());
      for (const order of ["desc", "asc"] as const) {
        const all = (await audit.query({ tenant: "acme", order })).items.map((e) => e.id);
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await audit.query({
            tenant: "acme",
            order,
            limit: 2,
            ...(cursor ? { cursor } : {}),
          });
          seen.push(...page.items.map((e) => e.id));
          cursor = page.pageInfo.endCursor ?? undefined;
          if (page.pageInfo.hasNextPage) expect(page.items).toHaveLength(2);
        } while (cursor);
        expect(seen).toEqual(all);
      }
      // New events do not shift an in-flight cursor.
      const first = await audit.query({ tenant: "acme", limit: 2 });
      await audit.record({
        tenant: "acme",
        action: "user.login",
        actor: { id: "u_9" },
        occurredAt: at(10),
      });
      const second = await audit.query({
        tenant: "acme",
        limit: 2,
        cursor: first.pageInfo.endCursor!,
      });
      expect(second.items.map((e) => e.action)).toEqual(["invoice.refunded", "invoice.paid"]);
    });

    test("eventsBySeq returns ascending slices", { timeout: t }, async () => {
      const { audit } = await seedEvents(await makeStorage());
      expect(
        (await audit.eventsBySeq("acme", { afterSeq: 1, limit: 2 })).map((e) => e.seq),
      ).toEqual([2, 3]);
      expect(await audit.eventsBySeq("acme", { afterSeq: 5, limit: 10 })).toEqual([]);
    });

    test("count and listTenants", { timeout: t }, async () => {
      const { audit } = await seedEvents(await makeStorage());
      expect(await audit.count("acme")).toBe(5);
      expect(await audit.count()).toBe(6);
      const tenants = await audit.listTenants();
      expect(tenants.map((x) => [x.key, x.head.seq, x.count])).toEqual([
        ["acme", 5, 5],
        ["globex", 1, 1],
      ]);
    });

    test("recordMany appends a batch per tenant in one chain run", { timeout: t }, async () => {
      const storage = await makeStorage();
      const audit = createAuditCore({ storage });
      const events = await audit.recordMany([
        { tenant: "a", action: "x.one", actor: { id: "1" } },
        { tenant: "b", action: "x.one", actor: { id: "1" } },
        { tenant: "a", action: "x.two", actor: { id: "1" } },
      ]);
      expect(events.map((e) => `${e.tenant}:${e.seq}`)).toEqual(["a:1", "b:1", "a:2"]);
      expect((await audit.verify("a")).ok).toBe(true);
    });

    test("idempotent re-record by explicit id", { timeout: t }, async () => {
      const storage = await makeStorage();
      const audit = createAuditCore({ storage });
      const input = {
        id: "evt_01JD0000000000000000000001",
        tenant: "a",
        action: "x.one",
        actor: { id: "1" },
        occurredAt: at(1),
      };
      const one = await audit.record(input);
      const two = await audit.record(input);
      expect(two).toEqual(one);
      expect(await audit.count("a")).toBe(1);
      await expect(audit.record({ ...input, metadata: { changed: true } })).rejects.toThrow(
        /different content/,
      );
    });

    test("concurrent records in one process never fork the chain", { timeout: t }, async () => {
      const storage = await makeStorage();
      const audit = createAuditCore({ storage });
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          audit.record({ tenant: "busy", action: "x.tick", actor: { id: String(i) } }),
        ),
      );
      const report = await audit.verify("busy");
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(20);
    });

    test("erase keeps the chain verifiable and is justified", { timeout: t }, async () => {
      const { audit, recorded } = await seedEvents(await makeStorage());
      const target = recorded[1]!;
      const erased = await audit.erase("acme", target.id, {
        sections: ["actor", "metadata"],
        reason: "gdpr",
      });
      expect(erased.metadata).toEqual({ $erased: true });
      expect(erased.actor.id).toMatch(/^erased:/);
      expect((await audit.get("acme", target.id))!.integrity.erased).toEqual(["actor", "metadata"]);
      const report = await audit.verify("acme");
      expect(report.ok).toBe(true);
      expect(report.erased).toEqual([
        { seq: target.seq, eventId: target.id, sections: ["actor", "metadata"] },
      ]);
      // The erased actor no longer matches its old id.
      expect((await audit.query({ tenant: "acme", actorId: "u_2" })).items).toEqual([]);
    });

    test("tampering is detected", { timeout: t }, async () => {
      const { audit, recorded } = await seedEvents(await makeStorage());
      const e = recorded[2]!;
      await audit.eventLog.replaceEvent({ ...e, metadata: { refunded: true } });
      const report = await audit.verify("acme");
      expect(report.ok).toBe(false);
      expect(report.issues.map((i) => i.kind)).toContain("digest-mismatch");
    });

    test("prune removes a prefix and the rest still verifies", { timeout: t }, async () => {
      const storage = await makeStorage();
      const audit = createAuditCore({
        storage,
        signer: hmacSigner("s3cret"),
        checkpoints: false,
        retention: { keepLast: 2 },
      });
      for (let i = 0; i < 6; i++)
        await audit.record({ tenant: "p", action: "x.tick", actor: { id: "1" } });
      const [result] = await audit.prune();
      expect(result).toEqual({ tenant: "p", pruned: 4, baseSeq: 5 });
      expect(await audit.count("p")).toBe(3); // 5, 6 + the audit_log.pruned record
      const head = await audit.head("p");
      expect(head.baseSeq).toBe(5);
      const report = await audit.verify("p");
      expect(report.ok).toBe(true);
      expect(report.anchor).toBe("checkpoint");
      // Appends continue the chain after a prune.
      const next = await audit.record({ tenant: "p", action: "x.tick", actor: { id: "1" } });
      expect(next.seq).toBe(8);
      expect((await audit.verify("p")).ok).toBe(true);
    });
  });

  describe(`EventLogStorage native semantics: ${name}`, () => {
    test("appendEvents rejects a stale expectedSeq atomically", { timeout: t }, async () => {
      const storage = await makeStorage();
      if (!hasEventLog(storage)) return;
      const base = {
        tenant: "n",
        action: "x.y",
        occurredAt: at(1),
        recordedAt: at(1),
        actor: { id: "1" },
        targets: [],
        context: {},
        metadata: {},
      };
      const [e1, e2] = await sealChain(
        [
          { ...base, id: "evt_01JD0000000000000000000001", seq: 1 },
          { ...base, id: "evt_01JD0000000000000000000002", seq: 2 },
        ],
        GENESIS_HASH,
      );
      await storage.appendEvents("n", [e1!], { expectedSeq: 0 });
      await expect(storage.appendEvents("n", [e1!], { expectedSeq: 0 })).rejects.toBeInstanceOf(
        ChainConflictError,
      );
      await storage.appendEvents("n", [e2!], { expectedSeq: 1 });
      expect((await storage.lastEvent("n"))!.seq).toBe(2);
      const result = await storage.queryEvents(normalizeQuery({ tenant: "n" }));
      expect(result.items.map((e) => e.seq).sort()).toEqual([1, 2]);
      expect(await storage.deleteEventsThrough("n", 1)).toBe(1);
      expect(await storage.countEvents("n")).toBe(1);
      expect(await storage.listEventTenants()).toContain("n");
    });
  });
}
