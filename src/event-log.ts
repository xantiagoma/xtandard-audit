/**
 * The event log the core talks to: the storage's native
 * {@link ./storage/contract.EventLogStorage} when it has one, otherwise the
 * **generic KV fallback** implemented here over the four-method contract
 * (ADR 0005).
 *
 * The fallback stores each event under `aud/t/{tenant}/events/{seq}` plus
 * secondary index keys (`ix/time`, `ix/actor`, `ix/action`, `ix/target`, see
 * {@link ./keys}). A query picks the most selective index, walks its keys in
 * `(occurredAt, id)` order, loads candidates, and applies the in-memory matcher
 * until the page is full. That is O(index size) key listing per query — fine
 * for development and modest volumes; use a native driver (Postgres, SQLite,
 * libSQL, MongoDB, Drizzle) at scale.
 *
 * Atomicity: an append writes the event keys one by one. Chain integrity across
 * processes is guarded by the core (compare-and-swap on the head when the
 * storage supports it); see docs/STORAGE.md.
 *
 * @module
 */

import {
  actionIndexPrefix,
  actorIndexPrefix,
  eventIdKey,
  eventKey,
  eventsPrefix,
  indexLeaf,
  parseEventKey,
  parseIndexLeaf,
  targetIndexPrefix,
  tenantsKey,
  timeIndexPrefix,
} from "./keys.ts";
import { compareEvents, isAfter, matchesQuery, type NormalizedQuery } from "./query.ts";
import type { AuditEvent } from "./schema.ts";
import {
  ChainConflictError,
  hasEventLog,
  type AuditStorage,
  type EventLogStorage,
} from "./storage/contract.ts";

/** The event-log operations the core needs (the native capability minus KV). */
export type EventLog = Pick<
  EventLogStorage,
  | "appendEvents"
  | "getEvent"
  | "lastEvent"
  | "eventsBySeq"
  | "queryEvents"
  | "replaceEvent"
  | "deleteEventsThrough"
  | "countEvents"
  | "listEventTenants"
> & {
  /** True when backed by the storage's native capability. */
  readonly native: boolean;
};

/** Resolve the event log for a storage: native capability or the KV fallback. */
export function resolveEventLog(storage: AuditStorage): EventLog {
  if (hasEventLog(storage)) {
    return {
      native: true,
      appendEvents: (t, e, o) => storage.appendEvents(t, e, o),
      getEvent: (t, id) => storage.getEvent(t, id),
      lastEvent: (t) => storage.lastEvent(t),
      eventsBySeq: (t, o) => storage.eventsBySeq(t, o),
      queryEvents: (q) => storage.queryEvents(q),
      replaceEvent: (e) => storage.replaceEvent(e),
      deleteEventsThrough: (t, s) => storage.deleteEventsThrough(t, s),
      countEvents: (t) => storage.countEvents(t),
      listEventTenants: () => storage.listEventTenants(),
    };
  }
  return createKvEventLog(storage);
}

/** Every index key an event occupies (time, actor, action, each target). */
export function indexKeysFor(event: AuditEvent): string[] {
  const leaf = indexLeaf(Date.parse(event.occurredAt), event.id);
  const keys = [
    `${timeIndexPrefix(event.tenant)}${leaf}`,
    `${actorIndexPrefix(event.tenant, event.actor.id)}${leaf}`,
    `${actionIndexPrefix(event.tenant, event.action)}${leaf}`,
  ];
  const seen = new Set<string>();
  for (const t of event.targets) {
    const k = `${targetIndexPrefix(event.tenant, t.type, t.id)}${leaf}`;
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

/** Choose the index prefix to scan for a query within one tenant. */
function indexPrefixFor(tenant: string, q: NormalizedQuery): string {
  if (q.actorId !== undefined) return actorIndexPrefix(tenant, q.actorId);
  if (q.targetType !== undefined && q.targetId !== undefined) {
    return targetIndexPrefix(tenant, q.targetType, q.targetId);
  }
  if (q.actions.length === 1 && q.actionPrefixes.length === 0) {
    return actionIndexPrefix(tenant, q.actions[0]!);
  }
  return timeIndexPrefix(tenant);
}

/** The generic event log over the four-method KV contract. */
export function createKvEventLog(storage: AuditStorage): EventLog {
  async function seqKeys(tenant: string): Promise<number[]> {
    const keys = await storage.getKeys(eventsPrefix(tenant));
    return keys
      .map(parseEventKey)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
  }

  async function tenants(): Promise<string[]> {
    return (await storage.getItem<string[]>(tenantsKey())) ?? [];
  }

  async function removeEvent(event: AuditEvent): Promise<void> {
    for (const k of indexKeysFor(event)) await storage.removeItem(k);
    await storage.removeItem(eventIdKey(event.tenant, event.id));
    await storage.removeItem(eventKey(event.tenant, event.seq));
  }

  return {
    native: false,

    async appendEvents(tenant, events, { expectedSeq }) {
      // Check-then-write: the next slot must be free. Cross-process exclusion is
      // the core's head compare-and-swap (or the single-writer assumption).
      const first = events[0];
      if (!first) return;
      if (first.seq !== expectedSeq + 1) throw new ChainConflictError(tenant, expectedSeq);
      if ((await storage.getItem(eventKey(tenant, first.seq))) !== null) {
        throw new ChainConflictError(tenant, expectedSeq);
      }
      for (const event of events) {
        await storage.setItem(eventKey(tenant, event.seq), event);
        await storage.setItem(eventIdKey(tenant, event.id), event.seq);
        for (const k of indexKeysFor(event)) await storage.setItem(k, event.seq);
      }
    },

    async getEvent(tenant, id) {
      const seq = await storage.getItem<number>(eventIdKey(tenant, id));
      if (seq === null) return null;
      return storage.getItem<AuditEvent>(eventKey(tenant, seq));
    },

    async lastEvent(tenant) {
      const seqs = await seqKeys(tenant);
      const last = seqs[seqs.length - 1];
      return last === undefined ? null : storage.getItem<AuditEvent>(eventKey(tenant, last));
    },

    async eventsBySeq(tenant, { afterSeq, limit }) {
      const seqs = (await seqKeys(tenant)).filter((s) => s > afterSeq).slice(0, limit);
      const out: AuditEvent[] = [];
      for (const s of seqs) {
        const e = await storage.getItem<AuditEvent>(eventKey(tenant, s));
        if (e) out.push(e);
      }
      return out;
    },

    async queryEvents(q) {
      const scope = q.tenant !== undefined ? [q.tenant] : await tenants();
      // Gather candidate positions from the chosen index of every tenant in scope.
      const candidates: { tenant: string; occurredAt: string; id: string; key: string }[] = [];
      for (const tenant of scope) {
        const prefix = indexPrefixFor(tenant, q);
        for (const key of await storage.getKeys(prefix)) {
          // Only direct children of the prefix (the time prefix is not a parent of others).
          if (key.slice(prefix.length).includes("/")) continue;
          const leaf = parseIndexLeaf(key);
          if (!leaf) continue;
          const occurredAt = new Date(leaf.ms).toISOString();
          if (q.from !== undefined && occurredAt < q.from) continue;
          if (q.to !== undefined && occurredAt >= q.to) continue;
          const pos = { occurredAt, id: leaf.id };
          if (q.after && !isAfter(pos, q.after, q.order)) continue;
          candidates.push({ tenant, ...pos, key });
        }
      }
      candidates.sort((a, b) => (q.order === "desc" ? compareEvents(b, a) : compareEvents(a, b)));

      const items: AuditEvent[] = [];
      for (const c of candidates) {
        const seq = await storage.getItem<number>(c.key);
        if (seq === null) continue;
        const event = await storage.getItem<AuditEvent>(eventKey(c.tenant, seq));
        if (!event || !matchesQuery(event, q)) continue;
        if (items.length === q.limit) return { items, hasMore: true };
        items.push(event);
      }
      return { items, hasMore: false };
    },

    async replaceEvent(event) {
      const existing = await storage.getItem<AuditEvent>(eventKey(event.tenant, event.seq));
      if (!existing || existing.id !== event.id) return;
      // Index keys depend on actor/targets, which erasure may change.
      for (const k of indexKeysFor(existing)) await storage.removeItem(k);
      await storage.setItem(eventKey(event.tenant, event.seq), event);
      for (const k of indexKeysFor(event)) await storage.setItem(k, event.seq);
    },

    async deleteEventsThrough(tenant, throughSeq) {
      let removed = 0;
      for (const s of await seqKeys(tenant)) {
        if (s > throughSeq) break;
        const event = await storage.getItem<AuditEvent>(eventKey(tenant, s));
        if (event) await removeEvent(event);
        else await storage.removeItem(eventKey(tenant, s));
        removed++;
      }
      return removed;
    },

    async countEvents(tenant) {
      const scope = tenant !== undefined ? [tenant] : await tenants();
      let n = 0;
      for (const t of scope) n += (await storage.getKeys(eventsPrefix(t))).length;
      return n;
    },

    async listEventTenants() {
      return tenants();
    },
  };
}
