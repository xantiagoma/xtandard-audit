/**
 * Testing utilities — `@xtandard/audit/testing`.
 *
 * Everything a host app (or this package's own suite) needs to test its audit
 * wiring without a database, timers or the network:
 *
 * - {@link createTestAudit}: an in-memory core, a {@link collectingSink}
 *   behind a **not-started** stream runner (drive it with `flush()`), an
 *   optional panel, and `events()` to read back everything recorded.
 * - {@link collectingSink}: a sink that keeps every batch it receives — with
 *   programmable failures to exercise the stream retry path.
 * - {@link expectRecorded} / {@link expectNotRecorded}: framework-agnostic
 *   assertions (they throw a descriptive `Error`) over what a core recorded.
 *
 * @module testing
 */

import { createAuditCore, type AuditCore, type AuditCoreOptions } from "./core.ts";
import type {
  AuditActor,
  AuditContext,
  AuditEvent,
  AuditOutcome,
  AuditTarget,
  JsonObject,
} from "./schema.ts";
import {
  createFetchHandler,
  type AuditPanelOptions,
  type CreateFetchHandlerResult,
} from "./server/create-fetch-handler.ts";
import type { ActionMap } from "./standard-schema.ts";
import { createMemoryStorage, type MemoryAuditStorage } from "./storage/memory.ts";
import {
  createStreamRunner,
  type AuditSink,
  type StreamBatch,
  type StreamDefinition,
  type StreamRunner,
} from "./streams.ts";
import type { AuditCheckpoint } from "./schema.ts";

/** A sink that records every batch it is sent. */
export interface CollectingSink extends AuditSink {
  /** Every batch accepted, in order. */
  readonly batches: StreamBatch[];
  /** Every event item accepted, in order. */
  events(): AuditEvent[];
  /** Every checkpoint item accepted, in order. */
  checkpoints(): AuditCheckpoint[];
  /** Reject the next `n` sends (default 1) with `error` (default a generic `Error`). */
  failNext(n?: number, error?: Error): void;
  /** Forget everything collected. */
  clear(): void;
}

/**
 * Create a {@link CollectingSink}.
 *
 * @example
 * ```ts
 * const sink = collectingSink();
 * const runner = createStreamRunner(audit, { streams: [{ name: "siem", sink, startFrom: "beginning" }] });
 * await runner.tick();
 * expect(sink.events().map((e) => e.action)).toEqual(["invoice.paid"]);
 * ```
 */
export function collectingSink(kind = "collecting"): CollectingSink {
  const batches: StreamBatch[] = [];
  let failures: { remaining: number; error: Error } = { remaining: 0, error: new Error() };
  return {
    kind,
    batches,
    async send(batch) {
      if (failures.remaining > 0) {
        failures.remaining--;
        throw failures.error;
      }
      batches.push(structuredClone(batch));
    },
    events: () =>
      batches.flatMap((b) => b.items.flatMap((i) => (i.kind === "event" ? [i.event] : []))),
    checkpoints: () =>
      batches.flatMap((b) =>
        b.items.flatMap((i) => (i.kind === "checkpoint" ? [i.checkpoint] : [])),
      ),
    failNext(n = 1, error = new Error("collectingSink: simulated failure")) {
      failures = { remaining: n, error };
    },
    clear() {
      batches.length = 0;
    },
  };
}

/** Options for {@link createTestAudit}. */
export interface TestAuditOptions<A extends ActionMap = ActionMap> extends Omit<
  AuditCoreOptions<A>,
  "storage"
> {
  /** Also build a panel over the same core (`true` for defaults). Its stream runner is not started. */
  panel?: Omit<AuditPanelOptions, "storage" | "core" | "streams" | "streamRunner"> | boolean;
  /** Extra streams beside the built-in `"test"` stream feeding {@link TestAudit.sink}. */
  streams?: StreamDefinition[];
}

/** Result of {@link createTestAudit}. */
export interface TestAudit<A extends ActionMap = ActionMap> {
  core: AuditCore<A>;
  storage: MemoryAuditStorage;
  /** Receives every event (and checkpoint) of every tenant once you `flush()`. */
  sink: CollectingSink;
  /** The NOT started runner behind `sink` — `flush()` ticks it. */
  streams: StreamRunner;
  /** The panel, when `panel` was requested. */
  panel: CreateFetchHandlerResult | null;
  /** Run one stream pass (delivers everything recorded so far to `sink`). */
  flush(): Promise<void>;
  /** Every stored event (all tenants, or one), oldest first. */
  events(tenant?: string): Promise<AuditEvent[]>;
}

/**
 * An in-memory audit core for tests, with a collecting sink streamed from the
 * beginning of every tenant's log. No timers run: call `flush()` to stream.
 *
 * @example
 * ```ts
 * import { createTestAudit, expectRecorded } from "@xtandard/audit/testing";
 *
 * const { core, sink, flush } = createTestAudit();
 * await core.record({ tenant: "acme", action: "invoice.paid", actor: { id: "u1" } });
 * await expectRecorded(core, { tenant: "acme", action: "invoice.paid", actor: { id: "u1" } });
 * await flush();
 * sink.events(); // → [the invoice.paid event]
 * ```
 */
export function createTestAudit<const A extends ActionMap = ActionMap>(
  options: TestAuditOptions<A> = {},
): TestAudit<A> {
  const storage = createMemoryStorage();
  const { panel: panelOptions, streams: extraStreams = [], ...coreOptions } = options;
  const core = createAuditCore<A>({ checkpoints: false, ...coreOptions, storage });
  const sink = collectingSink();
  const definitions: StreamDefinition[] = [
    { name: "test", sink, startFrom: "beginning" },
    ...extraStreams,
  ];
  const runner = createStreamRunner(core, { streams: definitions, maxBackoff: 0 });
  const panel = panelOptions
    ? createFetchHandler({
        ...(panelOptions === true ? {} : panelOptions),
        core: core as unknown as AuditCore<ActionMap>,
        maintenance: false,
      })
    : null;

  return {
    core,
    storage,
    sink,
    streams: runner,
    panel,
    flush: () => runner.tick(),
    async events(tenant) {
      const tenants = tenant ? [tenant] : (await core.listTenants()).map((t) => t.key);
      const out: AuditEvent[] = [];
      for (const t of tenants) {
        let after = 0;
        for (;;) {
          const page = await core.eventsBySeq(t, { afterSeq: after, limit: 500 });
          if (page.length === 0) break;
          out.push(...page);
          after = page[page.length - 1]!.seq;
        }
      }
      return out.sort((a, b) =>
        a.recordedAt === b.recordedAt
          ? a.id < b.id
            ? -1
            : 1
          : a.recordedAt < b.recordedAt
            ? -1
            : 1,
      );
    },
  };
}

/** What {@link expectRecorded} matches: every given field must match (deep subset). */
export interface RecordedMatcher {
  tenant?: string;
  action?: string;
  actor?: Partial<AuditActor>;
  /** Each listed target must be present (subset match on its fields). */
  targets?: Partial<AuditTarget>[];
  context?: Partial<AuditContext>;
  metadata?: JsonObject;
  outcome?: AuditOutcome;
  description?: string;
}

/** Deep subset: every key of `expected` matches in `actual` (arrays: every expected item matches some actual item). */
function subsetMatches(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((e) => actual.some((a) => subsetMatches(a, e)));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([k, v]) =>
    subsetMatches((actual as Record<string, unknown>)[k], v),
  );
}

async function findRecorded<A extends ActionMap>(
  core: AuditCore<A>,
  matcher: RecordedMatcher,
): Promise<{ match: AuditEvent | null; seen: AuditEvent[] }> {
  const seen: AuditEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await core.query({
      ...(matcher.tenant ? { tenant: matcher.tenant } : {}),
      ...(matcher.action ? { actions: [matcher.action] } : {}),
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    for (const event of page.items) {
      if (subsetMatches(event, matcher)) return { match: event, seen };
      seen.push(event);
    }
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return { match: null, seen };
    cursor = page.pageInfo.endCursor;
  }
}

/**
 * Assert that `core` recorded an event matching `matcher` (deep subset).
 * Resolves to the newest matching event; throws a descriptive `Error`
 * (listing what was recorded instead) otherwise. Works with any test runner.
 *
 * @example
 * ```ts
 * const event = await expectRecorded(core, {
 *   tenant: "acme",
 *   action: "member.role_changed",
 *   targets: [{ type: "user", id: "u2" }],
 *   metadata: { to: "admin" },
 * });
 * ```
 */
export async function expectRecorded<A extends ActionMap>(
  core: AuditCore<A>,
  matcher: RecordedMatcher,
): Promise<AuditEvent> {
  const { match, seen } = await findRecorded(core, matcher);
  if (match) return match;
  const summary = seen
    .slice(0, 10)
    .map((e) => `  - [${e.tenant}#${e.seq}] ${e.action} by ${e.actor.id}`)
    .join("\n");
  throw new Error(
    `Expected an audit event matching ${JSON.stringify(matcher)}, but none was recorded.` +
      (seen.length
        ? `\nCandidates (${seen.length}):\n${summary}${seen.length > 10 ? "\n  …" : ""}`
        : "\nNo candidate events (same tenant/action) were recorded."),
  );
}

/** Assert that `core` recorded **no** event matching `matcher`. */
export async function expectNotRecorded<A extends ActionMap>(
  core: AuditCore<A>,
  matcher: RecordedMatcher,
): Promise<void> {
  const { match } = await findRecorded(core, matcher);
  if (match) {
    throw new Error(
      `Expected no audit event matching ${JSON.stringify(matcher)}, but found ${match.id} ` +
        `([${match.tenant}#${match.seq}] ${match.action}).`,
    );
  }
}
