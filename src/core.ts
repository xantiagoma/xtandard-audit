/**
 * The audit core — the operations layer the API, CLI, recorder, stream runner
 * and UI sit on.
 *
 * Owns the split between the **record plane** (`record()` / `recordMany()` —
 * the hot path: validate, transform, chain, append; synchronous-commit, throws
 * on failure, ADR 0002) and the **control plane** (query, export, verify,
 * checkpoints, erasure, retention, the action catalog — hook-guarded and
 * self-audited).
 *
 * Import from `@xtandard/audit/core` (also re-exported by the root).
 *
 * @module core
 */

import { canonicalStringify } from "./canonical.ts";
import { getAuditContext } from "./context.ts";
import { durationToMs } from "./duration.ts";
import { resolveEventLog, type EventLog } from "./event-log.ts";
import {
  defaultHookErrorReporter,
  normalizeHooks,
  runAfter,
  runBefore,
  type AuditHooks,
  type AuditHooksInput,
  type HookActor,
  type HookErrorReporter,
} from "./hooks/contract.ts";
import { newId } from "./id.ts";
import {
  GENESIS_HASH,
  erasureIssues,
  sealChain,
  sectionValue,
  signCheckpoint,
  verifyChain,
  type AuditSigner,
  type AuditVerificationKey,
  type VerifyReport,
} from "./integrity.ts";
import {
  actionKey,
  actionsKey,
  checkpointKey,
  checkpointsPrefix,
  headKey,
  tenantsKey,
} from "./keys.ts";
import { normalizeQuery, toPage } from "./query.ts";
import type {
  ActionDefinition,
  AuditCheckpoint,
  AuditDuration,
  AuditEvent,
  AuditEventInput,
  AuditPage,
  AuditQuery,
  AuditSection,
  AuditTenant,
  ChainHead,
  JsonObject,
  JsonValue,
} from "./schema.ts";
import { AUDIT_SECTIONS } from "./schema.ts";
import { runStandardSchema, type ActionMap, type ActionMetadataInput } from "./standard-schema.ts";
import { ChainConflictError, isCompareAndSwap, type AuditStorage } from "./storage/contract.ts";
import { applyTransforms, type AuditTransform, type TransformableEvent } from "./transforms.ts";
import {
  assertValid,
  validateActionDefinition,
  validateEventInput,
  validateTenant,
  ValidationError,
} from "./validation.ts";

/** Thrown by mutating operations when the core is in readonly mode. */
export class ReadonlyError extends Error {
  constructor(operation: string) {
    super(`Cannot ${operation}: the audit core is readonly`);
    this.name = "ReadonlyError";
  }
}

/** Thrown when a referenced entity does not exist. Maps to HTTP 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Thrown when an operation conflicts with existing state. Maps to HTTP 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Thrown when an operation needs a signer and none is configured. Maps to HTTP 409. */
export class SignerRequiredError extends Error {
  constructor() {
    super("No signer configured: pass `signer` (ed25519Signer / hmacSigner) to the audit core");
    this.name = "SignerRequiredError";
  }
}

/**
 * One retention rule. When both fields are set an event is **kept if either
 * rule keeps it** (union of keeps, the sibling packages' semantics): pruned only
 * when it is outside the `keepLast` most recent AND older than `maxAge`.
 * Retention always removes a **prefix** of a tenant's chain (by seq), anchored
 * by a base checkpoint, so what remains still verifies (ADR 0004).
 */
export interface RetentionRule {
  /** Keep at most the N most recent events per tenant. */
  keepLast?: number;
  /** Keep events recorded within this age (e.g. `"365d"`). */
  maxAge?: AuditDuration;
}

/** Retention policy for {@link AuditCoreOptions.retention}. */
export interface RetentionOptions extends RetentionRule {
  /** Per-tenant overrides (e.g. an enterprise plan with longer retention). */
  tenants?: Record<string, RetentionRule>;
  /**
   * Prune even past stream cursors that have not caught up (default `false`:
   * events a stream has not delivered yet are kept, ADR 0008).
   */
  ignoreStreams?: boolean;
}

/** Automatic checkpointing (requires a `signer`). */
export interface CheckpointOptions {
  /** Sign the head after this many new events in a tenant. */
  every?: number;
  /** Sign the head when the last checkpoint is older than this (checked on record). */
  interval?: AuditDuration;
}

/** Options for {@link createAuditCore}. */
export interface AuditCoreOptions<A extends ActionMap = ActionMap> {
  /** Where everything lives (see `@xtandard/audit/storage/*`). */
  storage: AuditStorage;
  /** Typed action catalog from `defineActions` (ADR 0012). */
  actions?: A;
  /**
   * Reject actions that are not in `actions`. Default: `true` when `actions`
   * is given, `false` otherwise.
   */
  strictActions?: boolean;
  /** Redact / mask / hash / omit before chaining (see `@xtandard/audit` transforms). */
  transforms?: AuditTransform[];
  /** Merge the ambient request context (`@xtandard/audit/context`). Default `true`. */
  context?: boolean;
  /** Checkpoint signer (ADR 0004). Without one, checkpoints are unavailable. */
  signer?: AuditSigner;
  /** Extra keys `verify` accepts (e.g. retired signing keys). */
  verificationKeys?: AuditVerificationKey[];
  /** Automatic checkpoints. Default `{ every: 1000, interval: "1h" }` when a signer is set. */
  checkpoints?: CheckpointOptions | false;
  /** Retention. Pruning runs on demand ({@link AuditCore.prune}) or via the panel/CLI schedule. */
  retention?: RetentionOptions;
  /** Control-plane hooks (`before` may deny, `after` observes). */
  hooks?: AuditHooksInput;
  /** Reporter invoked when an `after` hook throws. Default `console.warn`. */
  onHookError?: HookErrorReporter;
  /** Fire-and-forget tap invoked with every committed batch (metrics, cache busting). */
  onRecord?: (events: AuditEvent[]) => void;
  /**
   * Record the log's own sensitive operations (exports, erasures, prunes) into
   * the affected tenant's log, and catalog changes into `systemTenant`.
   * Default `true`.
   */
  selfAudit?: boolean;
  /** Tenant receiving self-audit events that belong to no tenant. Default `"_system"`. */
  systemTenant?: string;
  /** Max serialized size of an event's free-form sections. Default 64 KiB. */
  maxEventBytes?: number;
  /** Block every mutation except recording when true (a read-only panel). */
  readonly?: boolean;
  /** Injectable clock (unix millis) for tests. Default `Date.now`. */
  now?: () => number;
}

/** Per-call actor attribution for control-plane operations. */
export interface ActorOptions {
  actor?: HookActor | null;
}

/** A record input, typed by the action map when one is given (ADR 0012). */
export type RecordInput<A extends ActionMap = ActionMap> = string extends keyof A
  ? Omit<AuditEventInput, "tenant"> & { tenant?: string }
  : {
      [K in keyof A & string]: Omit<AuditEventInput<K, ActionMetadataInput<A[K]>>, "tenant"> & {
        /** Defaults to the ambient context's tenant. */
        tenant?: string;
      };
    }[keyof A & string];

/** Input to {@link AuditCore.erase}. */
export interface EraseInput {
  /** Sections to erase. Default: every section. */
  sections?: AuditSection[];
  /** Why (recorded in the self-audit event). */
  reason?: string;
}

/** Result of one tenant's prune. */
export interface PruneResult {
  tenant: string;
  /** Events removed. */
  pruned: number;
  /** New first retained seq. */
  baseSeq: number;
}

/** Self-audit action names (always accepted, even with `strictActions`). */
export const SELF_AUDIT_ACTIONS = [
  "audit_log.exported",
  "audit_log.erased",
  "audit_log.pruned",
  "audit_log.action_upserted",
  "audit_log.action_deleted",
] as const;

/** The audit core surface. */
export interface AuditCore<A extends ActionMap = ActionMap> {
  readonly options: {
    storage: AuditStorage;
    actions?: A;
    strictActions: boolean;
    readonly: boolean;
    selfAudit: boolean;
    systemTenant: string;
    signer?: AuditSigner;
    retention?: RetentionOptions;
    checkpoints: CheckpointOptions | false;
    hooks: AuditHooks[];
    now: () => number;
  };
  /** The resolved event log (native or KV fallback). */
  readonly eventLog: EventLog;

  // Record plane
  /** Validate, transform, chain and append one event. Throws on failure (ADR 0002). */
  record(input: RecordInput<A>): Promise<AuditEvent>;
  /** Same as {@link record} for a batch; one chain append per tenant. */
  recordMany(inputs: RecordInput<A>[]): Promise<AuditEvent[]>;

  // Read
  query(query?: AuditQuery): Promise<AuditPage>;
  get(tenant: string, id: string): Promise<AuditEvent | null>;
  /** Events of a tenant with `seq > afterSeq`, ascending (streams, verification, bundles). */
  eventsBySeq(tenant: string, options: { afterSeq: number; limit: number }): Promise<AuditEvent[]>;
  count(tenant?: string): Promise<number>;
  listTenants(): Promise<AuditTenant[]>;
  head(tenant: string): Promise<ChainHead>;

  // Integrity
  /** Verify a tenant's chain (whole retained range, or `fromSeq`..`toSeq`). */
  verify(tenant: string, range?: { fromSeq?: number; toSeq?: number }): Promise<VerifyReport>;
  /** Sign the tenant's current head. Throws {@link SignerRequiredError} without a signer. */
  checkpoint(tenant: string, options?: ActorOptions): Promise<AuditCheckpoint>;
  listCheckpoints(tenant: string): Promise<AuditCheckpoint[]>;
  /** The public verification keys as a JWKS (empty for HMAC signers). */
  jwks(): Promise<{ keys: JsonWebKey[] }>;

  // Control plane
  erase(
    tenant: string,
    eventId: string,
    input?: EraseInput,
    options?: ActorOptions,
  ): Promise<AuditEvent>;
  /** Erase the `actor` section of every event by `actorId` in the tenant. Resolves to the count. */
  eraseActor(
    tenant: string,
    actorId: string,
    input?: { reason?: string },
    options?: ActorOptions,
  ): Promise<number>;
  /** Note an export (before hook + self-audit). The export module calls this. */
  noteExport(
    tenant: string,
    query: AuditQuery,
    format: string,
    options?: ActorOptions,
  ): Promise<void>;
  listActions(): Promise<ActionDefinition[]>;
  getAction(name: string): Promise<ActionDefinition | null>;
  upsertAction(input: ActionDefinition, options?: ActorOptions): Promise<ActionDefinition>;
  deleteAction(name: string, options?: ActorOptions): Promise<void>;

  // Retention
  prune(options?: ActorOptions): Promise<PruneResult[]>;
  pruneTenant(tenant: string, options?: ActorOptions): Promise<PruneResult>;
  /**
   * Register a lower bound retention must not prune past (stream runners
   * register their slowest cursor). Returns an unregister function.
   */
  addRetentionFloor(floor: (tenant: string) => Promise<number | null>): () => void;
}

const DEFAULT_CHECKPOINTS: CheckpointOptions = { every: 1000, interval: "1h" };
const MAX_CHAIN_RETRIES = 8;
const PRUNE_PAGE = 500;
const VERIFY_PAGE = 1000;

const isoNow = (now: () => number) => new Date(now()).toISOString();

/**
 * Create the audit core.
 *
 * @example
 * ```ts
 * import { createAuditCore } from "@xtandard/audit";
 * import { createMemoryStorage } from "@xtandard/audit/storage/memory";
 *
 * const audit = createAuditCore({ storage: createMemoryStorage() });
 *
 * await audit.record({
 *   tenant: "acme",
 *   action: "invoice.paid",
 *   actor: { id: "user_1", name: "Ada" },
 *   targets: [{ type: "invoice", id: "inv_1" }],
 *   metadata: { amount: 4200 },
 * });
 *
 * const page = await audit.query({ tenant: "acme", actions: ["invoice.*"] });
 * ```
 */
export function createAuditCore<const A extends ActionMap = ActionMap>(
  options: AuditCoreOptions<A>,
): AuditCore<A> {
  const storage = options.storage;
  const log = resolveEventLog(storage);
  const now = options.now ?? Date.now;
  const hooks = normalizeHooks(options.hooks);
  const onHookError = options.onHookError ?? defaultHookErrorReporter;
  const actions = options.actions;
  const strictActions = options.strictActions ?? actions !== undefined;
  const transforms = options.transforms ?? [];
  const useContext = options.context ?? true;
  const selfAudit = options.selfAudit ?? true;
  const systemTenant = options.systemTenant ?? "_system";
  const readonly = options.readonly ?? false;
  const signer = options.signer;
  const checkpointOpts =
    options.checkpoints === false
      ? false
      : (options.checkpoints ?? (signer ? DEFAULT_CHECKPOINTS : false));
  const cas = isCompareAndSwap(storage) ? storage : null;
  const floors = new Set<(tenant: string) => Promise<number | null>>();

  // ---- per-tenant serialization + head cache -----------------------------------------------

  const locks = new Map<string, Promise<unknown>>();
  function withTenantLock<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(tenant) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(tenant, tail);
    void tail.then(() => {
      if (locks.get(tenant) === tail) locks.delete(tenant);
    });
    return run;
  }

  /** Last head this process stored (the exact KV value, for compare-and-swap). */
  const storedHeads = new Map<string, ChainHead | null>();

  async function readHead(tenant: string): Promise<{ head: ChainHead; stored: ChainHead | null }> {
    const stored = await storage.getItem<ChainHead>(headKey(tenant));
    let head: ChainHead = stored ?? { tenant, seq: 0, hash: GENESIS_HASH };
    if (log.native) {
      // The event table is authoritative for native drivers (the KV head is a
      // best-effort cache written after the append).
      const last = await log.lastEvent(tenant);
      if (last && last.seq > head.seq) {
        head = { ...head, seq: last.seq, hash: last.integrity.hash };
      }
    }
    storedHeads.set(tenant, stored);
    return { head, stored };
  }

  async function writeHead(
    tenant: string,
    expected: ChainHead | null,
    next: ChainHead,
  ): Promise<boolean> {
    if (cas && !log.native) {
      const ok = await cas.compareAndSwap({ key: headKey(tenant), expected, next });
      if (ok) storedHeads.set(tenant, next);
      return ok;
    }
    await storage.setItem(headKey(tenant), next);
    storedHeads.set(tenant, next);
    return true;
  }

  async function ensureTenantIndexed(tenant: string): Promise<void> {
    const list = (await storage.getItem<string[]>(tenantsKey())) ?? [];
    if (list.includes(tenant)) return;
    await storage.setItem(tenantsKey(), [...list, tenant].sort());
  }

  // ---- record pipeline ---------------------------------------------------------------------

  type Prepared = TransformableEvent;

  async function prepare(input: RecordInput<A>, internal: boolean): Promise<Prepared> {
    const raw = input as AuditEventInput & { tenant?: string };
    const scope = useContext ? getAuditContext() : null;
    const tenant = raw.tenant ?? scope?.tenant;
    const actor = raw.actor ?? scope?.actor;
    const candidate = {
      ...raw,
      tenant,
      ...(actor ? { actor } : {}),
    };
    assertValid(validateEventInput(candidate, { maxEventBytes: options.maxEventBytes }));
    if (!actor) {
      throw new ValidationError([
        { path: "event.actor", message: "actor is required (pass it, or open an audit context)" },
      ]);
    }
    const spec = actions?.[raw.action];
    if (!internal && strictActions && !spec) {
      throw new ValidationError([
        { path: "event.action", message: `unknown action "${raw.action}"` },
      ]);
    }
    let metadata: JsonObject = (raw.metadata as JsonObject | undefined) ?? {};
    if (spec?.metadata) {
      const result = await runStandardSchema(spec.metadata, raw.metadata ?? {});
      if (!result.ok) {
        throw new ValidationError(
          result.issues.map((i) => ({
            path: i.path ? `event.metadata.${i.path}` : "event.metadata",
            message: i.message,
          })),
        );
      }
      const value = result.value as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError([
          {
            path: "event.metadata",
            message: "the action's metadata schema must produce an object",
          },
        ]);
      }
      metadata = value as JsonObject;
    }
    const occurredAt =
      raw.occurredAt === undefined
        ? isoNow(now)
        : new Date(
            raw.occurredAt instanceof Date ? raw.occurredAt.getTime() : Date.parse(raw.occurredAt),
          ).toISOString();
    const context = { ...scope?.context, ...raw.context };
    for (const k of Object.keys(context)) if (context[k] === undefined) delete context[k];
    const outcome = raw.outcome ?? spec?.outcome;
    const prepared: Prepared = {
      id: raw.id ?? newId("evt", now()),
      tenant: tenant!,
      action: raw.action,
      occurredAt,
      actor: structuredClone(actor),
      targets: structuredClone(raw.targets ?? []),
      context: structuredClone(context),
      metadata: structuredClone(metadata),
      ...(outcome ? { outcome } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
    };
    // JSON round-trip check: everything hashed must be canonicalizable.
    for (const s of AUDIT_SECTIONS) {
      try {
        canonicalStringify(sectionValue({ ...prepared, seq: 0, recordedAt: "" }, s));
      } catch (err) {
        throw new ValidationError([{ path: `event.${s}`, message: (err as Error).message }]);
      }
    }
    const transformed = transforms.length ? await applyTransforms(prepared, transforms) : prepared;
    return transformed;
  }

  /** Same logical content (for idempotent re-record by explicit id). */
  function sameContent(a: Prepared, b: AuditEvent): boolean {
    const pick = (e: Prepared | AuditEvent) =>
      canonicalStringify({
        action: e.action,
        occurredAt: e.occurredAt,
        actor: e.actor,
        targets: e.targets,
        context: e.context,
        metadata: e.metadata,
        outcome: e.outcome ?? null,
        description: e.description ?? null,
      } as unknown as JsonValue);
    return pick(a) === pick(b);
  }

  async function appendForTenant(tenant: string, batch: Prepared[]): Promise<AuditEvent[]> {
    return withTenantLock(tenant, async () => {
      // Idempotency: explicit ids already stored are returned, not re-chained.
      const existing = new Map<string, AuditEvent>();
      for (const p of batch) {
        const found = await log.getEvent(tenant, p.id);
        if (found) {
          if (!sameContent(p, found)) {
            throw new ConflictError(`Event ${p.id} already exists with different content`);
          }
          existing.set(p.id, found);
        }
      }
      const fresh = batch.filter((p) => !existing.has(p.id));
      let sealed: AuditEvent[] = [];
      if (fresh.length > 0) {
        for (let attempt = 0; ; attempt++) {
          const { head, stored } = await readHead(tenant);
          const recordedAt = isoNow(now);
          sealed = await sealChain(
            fresh.map((p, i) => ({ ...p, seq: head.seq + i + 1, recordedAt })),
            head.hash,
          );
          const last = sealed[sealed.length - 1]!;
          const next: ChainHead = {
            ...head,
            tenant,
            seq: last.seq,
            hash: last.integrity.hash,
            updatedAt: recordedAt,
          };
          try {
            if (!log.native) {
              // KV fallback: claim the seq range on the head first (CAS when available).
              if (!(await writeHead(tenant, stored, next)))
                throw new ChainConflictError(tenant, head.seq);
              await log.appendEvents(tenant, sealed, { expectedSeq: head.seq });
            } else {
              await log.appendEvents(tenant, sealed, { expectedSeq: head.seq });
              await writeHead(tenant, stored, next);
            }
            break;
          } catch (err) {
            if (err instanceof ChainConflictError && attempt < MAX_CHAIN_RETRIES) continue;
            throw err;
          }
        }
        if (firstSeenThisProcess(tenant)) await ensureTenantIndexed(tenant);
      }
      return batch.map((p) => existing.get(p.id) ?? sealed.find((s) => s.id === p.id)!);
    });
  }

  // Tenants this process already knows are indexed (avoids a read per record).
  const indexedTenants = new Set<string>();
  function firstSeenThisProcess(tenant: string): boolean {
    if (indexedTenants.has(tenant)) return false;
    indexedTenants.add(tenant);
    return true;
  }

  async function recordPrepared(prepared: Prepared[], internal: boolean): Promise<AuditEvent[]> {
    const byTenant = new Map<string, Prepared[]>();
    for (const p of prepared) {
      const list = byTenant.get(p.tenant) ?? [];
      list.push(p);
      byTenant.set(p.tenant, list);
    }
    const results = new Map<string, AuditEvent>();
    for (const [tenant, batch] of byTenant) {
      if (!internal && hooks.length) {
        await runBefore(hooks, {
          type: "event.record",
          tenant,
          actions: [...new Set(batch.map((b) => b.action))],
          count: batch.length,
        });
      }
      const sealed = await appendForTenant(tenant, batch);
      for (const e of sealed) results.set(e.id, e);
      const at = isoNow(now);
      if (hooks.length)
        void runAfter(hooks, { type: "events.recorded", tenant, events: sealed, at }, onHookError);
      if (options.onRecord) {
        try {
          options.onRecord(sealed);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[@xtandard/audit] onRecord threw:", err);
        }
      }
      void maybeAutoCheckpoint(tenant);
    }
    return prepared.map((p) => results.get(p.id)!);
  }

  async function recordInternal(input: AuditEventInput): Promise<AuditEvent | null> {
    if (!selfAudit) return null;
    const prepared = await prepare(input as RecordInput<A>, true);
    const [event] = await recordPrepared([prepared], true);
    return event ?? null;
  }

  function actorFor(actor: HookActor | null | undefined) {
    return actor
      ? {
          id: actor.id,
          type: actor.id.startsWith("portal:") ? "portal" : "operator",
          ...(actor.name ? { name: actor.name } : {}),
          ...(actor.email ? { email: actor.email } : {}),
        }
      : { id: "system", type: "system" };
  }

  // ---- checkpoints -------------------------------------------------------------------------

  async function listCheckpoints(tenant: string): Promise<AuditCheckpoint[]> {
    const keys = (await storage.getKeys(checkpointsPrefix(tenant))).sort();
    const out: AuditCheckpoint[] = [];
    for (const k of keys) {
      const cp = await storage.getItem<AuditCheckpoint>(k);
      if (cp) out.push(cp);
    }
    return out.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
  }

  async function storeCheckpoint(cp: AuditCheckpoint): Promise<void> {
    await storage.setItem(checkpointKey(cp.tenant, cp.id), cp);
  }

  async function createCheckpoint(
    tenant: string,
    actor: HookActor | null,
  ): Promise<AuditCheckpoint> {
    if (!signer) throw new SignerRequiredError();
    if (hooks.length) await runBefore(hooks, { type: "checkpoint.create", tenant, actor });
    const { head } = await readHead(tenant);
    const at = isoNow(now);
    const cp = await signCheckpoint(signer, {
      v: 1,
      id: newId("chk", now()),
      tenant,
      kind: "head",
      seq: head.seq,
      hash: head.hash,
      at,
    });
    await storeCheckpoint(cp);
    lastCheckpoint.set(tenant, { seq: cp.seq, at: now() });
    if (hooks.length)
      void runAfter(hooks, { type: "checkpoint.created", tenant, checkpoint: cp, at }, onHookError);
    return cp;
  }

  const lastCheckpoint = new Map<string, { seq: number; at: number }>();
  const checkpointing = new Set<string>();

  async function maybeAutoCheckpoint(tenant: string): Promise<void> {
    if (!signer || !checkpointOpts || checkpointing.has(tenant)) return;
    checkpointing.add(tenant);
    try {
      let last = lastCheckpoint.get(tenant);
      if (!last) {
        const cps = (await listCheckpoints(tenant)).filter((c) => c.kind === "head");
        const newest = cps[cps.length - 1];
        last = newest ? { seq: newest.seq, at: Date.parse(newest.at) } : { seq: 0, at: 0 };
        lastCheckpoint.set(tenant, last);
      }
      const head = await withTenantLock(tenant, async () => (await readHead(tenant)).head);
      if (head.seq <= last.seq) return;
      const dueByCount =
        checkpointOpts.every !== undefined && head.seq - last.seq >= checkpointOpts.every;
      const dueByTime =
        checkpointOpts.interval !== undefined &&
        now() - last.at >= durationToMs(checkpointOpts.interval);
      if (dueByCount || dueByTime) await createCheckpoint(tenant, null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[@xtandard/audit] automatic checkpoint for "${tenant}" failed:`, err);
    } finally {
      checkpointing.delete(tenant);
    }
  }

  async function verificationKeys(): Promise<AuditVerificationKey[]> {
    const keys = [...(options.verificationKeys ?? [])];
    if (signer) keys.push(await signer.verificationKey());
    return keys;
  }

  // ---- retention ---------------------------------------------------------------------------

  function ruleFor(tenant: string): RetentionRule | null {
    const r = options.retention;
    if (!r) return null;
    const rule = {
      ...(r.keepLast !== undefined ? { keepLast: r.keepLast } : {}),
      ...(r.maxAge !== undefined ? { maxAge: r.maxAge } : {}),
      ...r.tenants?.[tenant],
    };
    return rule.keepLast === undefined && rule.maxAge === undefined ? null : rule;
  }

  async function pruneTenant(tenant: string, actor: HookActor | null): Promise<PruneResult> {
    if (readonly) throw new ReadonlyError("prune");
    const rule = ruleFor(tenant);
    const { head } = await readHead(tenant);
    const baseSeq = head.baseSeq ?? 1;
    if (!rule || head.seq === 0) return { tenant, pruned: 0, baseSeq };

    // An event is pruned only when every configured rule lets it go (union of keeps).
    const cutoff =
      rule.maxAge !== undefined ? new Date(now() - durationToMs(rule.maxAge)).toISOString() : null;
    let limit = rule.keepLast !== undefined ? head.seq - rule.keepLast : Infinity;
    // Never prune the head itself: it anchors the next append and future checkpoints.
    limit = Math.min(limit, head.seq - 1);
    if (!options.retention?.ignoreStreams) {
      for (const floor of floors) {
        const f = await floor(tenant);
        if (f !== null) limit = Math.min(limit, f);
      }
    }
    let through = baseSeq - 1;
    if (cutoff === null) {
      through = Math.max(through, limit);
    } else {
      let after = baseSeq - 1;
      scan: for (;;) {
        const page = await log.eventsBySeq(tenant, { afterSeq: after, limit: PRUNE_PAGE });
        if (page.length === 0) break;
        for (const e of page) {
          if (e.seq > limit || e.recordedAt >= cutoff) break scan;
          through = e.seq;
        }
        after = page[page.length - 1]!.seq;
      }
    }
    if (through < baseSeq) return { tenant, pruned: 0, baseSeq };

    if (hooks.length)
      await runBefore(hooks, { type: "events.prune", tenant, throughSeq: through, actor });
    const boundary = (await log.eventsBySeq(tenant, { afterSeq: through - 1, limit: 1 }))[0];
    if (!boundary || boundary.seq !== through) return { tenant, pruned: 0, baseSeq };

    let base: AuditCheckpoint | null = null;
    if (signer) {
      base = await signCheckpoint(signer, {
        v: 1,
        id: newId("chk", now()),
        tenant,
        kind: "base",
        seq: through,
        hash: boundary.integrity.hash,
        at: isoNow(now),
      });
      await storeCheckpoint(base);
    }
    const pruned = await withTenantLock(tenant, async () => {
      const count = await log.deleteEventsThrough(tenant, through);
      const { head: current, stored } = await readHead(tenant);
      await writeHead(tenant, stored, {
        ...current,
        baseSeq: through + 1,
        baseHash: boundary.integrity.hash,
      });
      return count;
    });
    // Checkpoints that sign pruned heads are no longer checkable; drop all but base anchors.
    for (const cp of await listCheckpoints(tenant)) {
      if (cp.seq < through) {
        await storage.removeItem(checkpointKey(tenant, cp.id));
      }
    }
    const at = isoNow(now);
    if (hooks.length)
      void runAfter(
        hooks,
        { type: "events.pruned", tenant, throughSeq: through, count: pruned, base, at },
        onHookError,
      );
    await recordInternal({
      tenant,
      action: "audit_log.pruned",
      actor: actorFor(actor),
      metadata: { throughSeq: through, count: pruned },
    });
    return { tenant, pruned, baseSeq: through + 1 };
  }

  // ---- catalog -----------------------------------------------------------------------------

  let catalogSynced = false;
  async function syncCatalog(): Promise<void> {
    if (catalogSynced || !actions) return;
    catalogSynced = true;
    const names = new Set((await storage.getItem<string[]>(actionsKey())) ?? []);
    const at = isoNow(now);
    for (const [name, spec] of Object.entries(actions)) {
      const existing = await storage.getItem<ActionDefinition>(actionKey(name));
      const def: ActionDefinition = {
        ...existing,
        name,
        source: "code",
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        ...(spec.group !== undefined ? { group: spec.group } : {}),
        ...(spec.targets !== undefined ? { targets: spec.targets } : {}),
        ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
        ...(spec.deprecated !== undefined ? { deprecated: spec.deprecated } : {}),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      if (
        !existing ||
        canonicalStringify({ ...existing, updatedAt: "" } as unknown as JsonValue) !==
          canonicalStringify({ ...def, updatedAt: "" } as unknown as JsonValue)
      ) {
        await storage.setItem(actionKey(name), def);
      }
      names.add(name);
    }
    await storage.setItem(actionsKey(), [...names].sort());
  }

  // ---- the surface -------------------------------------------------------------------------

  const core: AuditCore<A> = {
    options: {
      storage,
      ...(actions ? { actions } : {}),
      strictActions,
      readonly,
      selfAudit,
      systemTenant,
      ...(signer ? { signer } : {}),
      ...(options.retention ? { retention: options.retention } : {}),
      checkpoints: checkpointOpts,
      hooks,
      now,
    },
    eventLog: log,

    async record(input) {
      const [event] = await recordPrepared([await prepare(input, false)], false);
      return event!;
    },

    async recordMany(inputs) {
      if (inputs.length === 0) return [];
      const prepared: Prepared[] = [];
      for (const input of inputs) prepared.push(await prepare(input, false));
      return recordPrepared(prepared, false);
    },

    async query(query = {}) {
      return toPage(await log.queryEvents(normalizeQuery(query)));
    },

    get: (tenant, id) => log.getEvent(tenant, id),

    eventsBySeq: (tenant, o) => log.eventsBySeq(tenant, o),

    count: (tenant) => log.countEvents(tenant),

    async listTenants() {
      const keys = new Set((await storage.getItem<string[]>(tenantsKey())) ?? []);
      if (log.native) for (const t of await log.listEventTenants()) keys.add(t);
      const out: AuditTenant[] = [];
      for (const key of [...keys].sort()) {
        const { head } = await readHead(key);
        out.push({ key, head, count: await log.countEvents(key) });
      }
      return out;
    },

    async head(tenant) {
      assertValid(validateTenant(tenant));
      return (await readHead(tenant)).head;
    },

    async verify(tenant, range = {}) {
      assertValid(validateTenant(tenant));
      const { head } = await readHead(tenant);
      const checkpoints = await listCheckpoints(tenant);
      const keys = await verificationKeys();
      const fromSeq = Math.max(range.fromSeq ?? head.baseSeq ?? 1, head.baseSeq ?? 1);
      const toSeq = Math.min(range.toSeq ?? head.seq, head.seq);
      // Verify page by page, carrying the last event over so links are checked across pages.
      let after = fromSeq - 1;
      let carry: AuditEvent | null = null;
      let report: VerifyReport | null = null;
      const erasureRecords: AuditEvent[] = [];
      while (after < toSeq) {
        const page = (
          await log.eventsBySeq(tenant, { afterSeq: after, limit: VERIFY_PAGE })
        ).filter((e) => e.seq <= toSeq);
        if (page.length === 0) break;
        const window = carry ? [carry, ...page] : page;
        const lo = window[0]!.seq;
        const hi = window[window.length - 1]!.seq;
        const r = await verifyChain(window, {
          // Each checkpoint is checked in exactly one window.
          checkpoints: checkpoints.filter(
            (c) => c.seq >= (carry ? carry.seq + 1 : lo - 1) && c.seq <= hi,
          ),
          ...(keys.length ? { keys } : {}),
          requireErasureRecords: false,
        });
        for (const e of page) if (e.action === "audit_log.erased") erasureRecords.push(e);
        report = mergeReports(report, r, carry !== null);
        carry = page[page.length - 1]!;
        after = carry.seq;
      }
      if (!report) {
        return {
          ok: true,
          tenant,
          checked: 0,
          fromSeq: null,
          toSeq: null,
          headHash: null,
          anchor: "none",
          linksChecked: true,
          checkpointsVerified: 0,
          signedThrough: null,
          erased: [],
          issues: [],
        };
      }
      if (selfAudit && report.erased.length > 0) {
        // Justifications can live after the verified range (up to the head).
        if (toSeq < head.seq) {
          let a = toSeq;
          for (;;) {
            const more = await log.eventsBySeq(tenant, { afterSeq: a, limit: VERIFY_PAGE });
            if (more.length === 0) break;
            for (const e of more) if (e.action === "audit_log.erased") erasureRecords.push(e);
            a = more[more.length - 1]!.seq;
          }
        }
        const extra = erasureIssues(report.erased, erasureRecords);
        if (extra.length) {
          report.issues.push(...extra);
          report.ok = false;
        }
      }
      // A missing tail (seq gap at the end) is a truncation.
      if (report.toSeq !== null && report.toSeq < toSeq) {
        report.issues.push({
          kind: "seq-gap",
          seq: report.toSeq + 1,
          message: `events ${report.toSeq + 1}..${toSeq} are missing`,
        });
        report.ok = false;
      }
      return report;
    },

    async checkpoint(tenant, opts = {}) {
      assertValid(validateTenant(tenant));
      return createCheckpoint(tenant, opts.actor ?? null);
    },

    listCheckpoints: (tenant) => listCheckpoints(tenant),

    async jwks() {
      const keys: JsonWebKey[] = [];
      const pub = await signer?.publicJwk?.();
      if (pub) keys.push(pub);
      return { keys };
    },

    async erase(tenant, eventId, input = {}, opts = {}) {
      if (readonly) throw new ReadonlyError("erase events");
      const sections = input.sections?.length ? input.sections : [...AUDIT_SECTIONS];
      for (const s of sections) {
        if (!AUDIT_SECTIONS.includes(s)) {
          throw new ValidationError([{ path: "sections", message: `unknown section "${s}"` }]);
        }
      }
      const actor = opts.actor ?? null;
      if (hooks.length) {
        await runBefore(hooks, {
          type: "event.erase",
          tenant,
          eventId,
          sections,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          actor,
        });
      }
      const updated = await withTenantLock(tenant, async () => {
        const event = await log.getEvent(tenant, eventId);
        if (!event) throw new NotFoundError(`Event ${eventId} not found in tenant "${tenant}"`);
        const next = eraseSections(event, sections);
        await log.replaceEvent(next);
        return next;
      });
      const at = isoNow(now);
      if (hooks.length)
        void runAfter(
          hooks,
          { type: "event.erased", tenant, event: updated, sections, at },
          onHookError,
        );
      await recordInternal({
        tenant,
        action: "audit_log.erased",
        actor: actorFor(actor),
        targets: [{ type: "audit_event", id: eventId }],
        metadata: { eventId, sections, ...(input.reason ? { reason: input.reason } : {}) },
      });
      return updated;
    },

    async eraseActor(tenant, actorId, input = {}, opts = {}) {
      let count = 0;
      let cursor: string | undefined;
      const ids: string[] = [];
      do {
        const page = await core.query({
          tenant,
          actorId,
          limit: 500,
          order: "asc",
          ...(cursor ? { cursor } : {}),
        });
        ids.push(
          ...page.items.filter((e) => !e.integrity.erased?.includes("actor")).map((e) => e.id),
        );
        cursor = page.pageInfo.endCursor ?? undefined;
      } while (cursor);
      for (const id of ids) {
        await core.erase(
          tenant,
          id,
          { sections: ["actor"], ...(input.reason ? { reason: input.reason } : {}) },
          opts,
        );
        count++;
      }
      return count;
    },

    async noteExport(tenant, query, format, opts = {}) {
      const actor = opts.actor ?? null;
      if (hooks.length)
        await runBefore(hooks, { type: "events.export", tenant, query, format, actor });
      if (hooks.length)
        void runAfter(
          hooks,
          { type: "events.exported", tenant, query, format, at: isoNow(now) },
          onHookError,
        );
      await recordInternal({
        tenant,
        action: "audit_log.exported",
        actor: actorFor(actor),
        metadata: { format, query: query as unknown as JsonObject },
      });
    },

    async listActions() {
      await syncCatalog();
      const names = (await storage.getItem<string[]>(actionsKey())) ?? [];
      const out: ActionDefinition[] = [];
      for (const n of names) {
        const def = await storage.getItem<ActionDefinition>(actionKey(n));
        if (def) out.push(def);
      }
      return out;
    },

    async getAction(name) {
      await syncCatalog();
      return storage.getItem<ActionDefinition>(actionKey(name));
    },

    async upsertAction(input, opts = {}) {
      if (readonly) throw new ReadonlyError("upsert actions");
      assertValid(validateActionDefinition(input));
      await syncCatalog();
      const actor = opts.actor ?? null;
      const existing = await storage.getItem<ActionDefinition>(actionKey(input.name));
      const at = isoNow(now);
      const def: ActionDefinition = {
        ...existing,
        ...input,
        source: existing?.source ?? "ui",
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      if (hooks.length) await runBefore(hooks, { type: "action.upsert", action: def, actor });
      await storage.setItem(actionKey(def.name), def);
      const names = new Set((await storage.getItem<string[]>(actionsKey())) ?? []);
      names.add(def.name);
      await storage.setItem(actionsKey(), [...names].sort());
      if (hooks.length)
        void runAfter(hooks, { type: "action.upserted", action: def, at }, onHookError);
      await recordInternal({
        tenant: systemTenant,
        action: "audit_log.action_upserted",
        actor: actorFor(actor),
        targets: [{ type: "audit_action", id: def.name }],
        metadata: { action: def as unknown as JsonObject },
      });
      return def;
    },

    async deleteAction(name, opts = {}) {
      if (readonly) throw new ReadonlyError("delete actions");
      await syncCatalog();
      const existing = await storage.getItem<ActionDefinition>(actionKey(name));
      if (!existing) throw new NotFoundError(`Action "${name}" not found`);
      if (actions?.[name])
        throw new ConflictError(`Action "${name}" is defined in code; remove it there`);
      const actor = opts.actor ?? null;
      if (hooks.length) await runBefore(hooks, { type: "action.delete", name, actor });
      await storage.removeItem(actionKey(name));
      const names = ((await storage.getItem<string[]>(actionsKey())) ?? []).filter(
        (n) => n !== name,
      );
      await storage.setItem(actionsKey(), names);
      if (hooks.length)
        void runAfter(
          hooks,
          { type: "action.deleted", name, action: existing, at: isoNow(now) },
          onHookError,
        );
      await recordInternal({
        tenant: systemTenant,
        action: "audit_log.action_deleted",
        actor: actorFor(actor),
        targets: [{ type: "audit_action", id: name }],
      });
    },

    async prune(opts = {}) {
      const results: PruneResult[] = [];
      for (const t of await core.listTenants())
        results.push(await pruneTenant(t.key, opts.actor ?? null));
      return results;
    },

    pruneTenant: (tenant, opts = {}) => pruneTenant(tenant, opts.actor ?? null),

    addRetentionFloor(floor) {
      floors.add(floor);
      return () => {
        floors.delete(floor);
      };
    },
  };
  return core;
}

/** Erase sections of an event, keeping its digests (ADR 0011). */
export function eraseSections(event: AuditEvent, sections: readonly AuditSection[]): AuditEvent {
  const next: AuditEvent = structuredClone(event);
  const erased = new Set(next.integrity.erased ?? []);
  for (const s of sections) {
    erased.add(s);
    const digest = next.integrity.digests[s] ?? "";
    switch (s) {
      case "actor":
        next.actor = { id: `erased:${digest.slice(7, 19)}` };
        break;
      case "targets":
        next.targets = [];
        break;
      case "context":
        next.context = { $erased: true };
        break;
      case "metadata":
        next.metadata = { $erased: true };
        break;
      case "description":
        delete next.description;
        break;
    }
  }
  next.integrity.erased = AUDIT_SECTIONS.filter((s) => erased.has(s));
  return next;
}

/** Merge two page reports of one verification run. */
function mergeReports(a: VerifyReport | null, b: VerifyReport, overlapping: boolean): VerifyReport {
  if (!a) return b;
  const dedupe = (issues: VerifyReport["issues"]) => {
    const seen = new Set<string>();
    return issues.filter((i) => {
      const k = `${i.kind}|${i.seq}|${i.eventId}|${i.checkpointId}|${i.section}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const issues = dedupe([...a.issues, ...b.issues]);
  const erasedSeen = new Set(a.erased.map((e) => e.seq));
  return {
    ok: issues.length === 0,
    tenant: a.tenant ?? b.tenant,
    checked: a.checked + b.checked - (overlapping ? 1 : 0),
    fromSeq: a.fromSeq,
    toSeq: b.toSeq ?? a.toSeq,
    headHash: b.headHash ?? a.headHash,
    anchor: a.anchor,
    linksChecked: a.linksChecked && b.linksChecked,
    checkpointsVerified: a.checkpointsVerified + b.checkpointsVerified,
    signedThrough:
      b.signedThrough !== null || a.signedThrough !== null
        ? Math.max(a.signedThrough ?? 0, b.signedThrough ?? 0)
        : null,
    erased: [...a.erased, ...b.erased.filter((e) => !erasedSeen.has(e.seq))],
    issues,
  };
}
