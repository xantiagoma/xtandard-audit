/**
 * Hook contracts — control-plane extensibility around audit mutations.
 *
 * A hook is plain JavaScript wired in at {@link ../core.createAuditCore} time
 * (never authored through the UI — that would be remote code execution). Two
 * phases, deliberately asymmetric (identical to the sibling packages):
 *
 * - **`before`** runs *before* a mutation commits. Throwing **denies** the
 *   operation (the thrown error's message is the reason). Multiple `before`
 *   hooks run **sequentially in declared order**; the first throw aborts and
 *   nothing commits. Quotas, policy gates and export approvals build on this.
 * - **`after`** runs *after* a mutation commits, for side effects. An `after`
 *   hook **must never fail the operation**, so errors are isolated and reported
 *   via `onHookError`, not rethrown.
 *
 * Recording is a hook event too (`event.record` / `events.recorded`), so a host
 * can gate or observe the hot path; the cheaper per-event tap is the
 * fire-and-forget `onRecord` option.
 *
 * @module
 */

import type {
  ActionDefinition,
  AuditCheckpoint,
  AuditEvent,
  AuditQuery,
  AuditSection,
} from "../schema.ts";

/** Who performed a control-plane operation (from the authenticated principal). */
export interface HookActor {
  id: string;
  email?: string;
  name?: string;
}

/**
 * Event delivered to {@link AuditHooks.before} — the *proposed* mutation,
 * before it commits. Throw from the handler to deny it.
 */
export type BeforeEvent =
  | {
      /** The record gate (quota, policy). Runs once per `record`/`recordMany` call per tenant. */
      type: "event.record";
      tenant: string;
      actions: string[];
      count: number;
    }
  | {
      type: "event.erase";
      tenant: string;
      eventId: string;
      sections: AuditSection[];
      reason?: string;
      actor: HookActor | null;
    }
  | {
      type: "events.export";
      tenant: string;
      query: AuditQuery;
      format: string;
      actor: HookActor | null;
    }
  | { type: "events.prune"; tenant: string; throughSeq: number; actor: HookActor | null }
  | { type: "action.upsert"; action: ActionDefinition; actor: HookActor | null }
  | { type: "action.delete"; name: string; actor: HookActor | null }
  | { type: "checkpoint.create"; tenant: string; actor: HookActor | null };

/**
 * Event delivered to {@link AuditHooks.after} — the *committed* mutation.
 */
export type AfterEvent =
  | { type: "events.recorded"; tenant: string; events: AuditEvent[]; at: string }
  | {
      type: "event.erased";
      tenant: string;
      event: AuditEvent;
      sections: AuditSection[];
      at: string;
    }
  | { type: "events.exported"; tenant: string; query: AuditQuery; format: string; at: string }
  | {
      /** Retention removed a prefix of the chain; `base` anchors what remains. */
      type: "events.pruned";
      tenant: string;
      throughSeq: number;
      count: number;
      base: AuditCheckpoint | null;
      at: string;
    }
  | { type: "action.upserted"; action: ActionDefinition; at: string }
  | { type: "action.deleted"; name: string; action: ActionDefinition; at: string }
  | { type: "checkpoint.created"; tenant: string; checkpoint: AuditCheckpoint; at: string };

/** The discriminant strings of {@link BeforeEvent} / {@link AfterEvent}. */
export type BeforeEventType = BeforeEvent["type"];
export type AfterEventType = AfterEvent["type"];

/**
 * Thrown from a {@link AuditHooks.before} handler to **deny** a mutation with
 * a clean HTTP status (default `403`). Any thrown error denies the mutation,
 * but a plain `Error` maps to `500` at the API layer (treated as an unexpected
 * bug); throw this to signal a deliberate policy rejection (`403`, or a custom
 * `status` such as `409`/`422`).
 *
 * @example
 * ```ts
 * before(event) {
 *   if (event.type === "event.record" && overQuota(event.tenant)) {
 *     throw new HookDeniedError("Monthly audit quota exceeded.", { status: 429 });
 *   }
 * }
 * ```
 */
export class HookDeniedError extends Error {
  /** HTTP status the API layer should respond with. Default `403`. */
  readonly status: number;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HookDeniedError";
    this.status = options?.status ?? 403;
  }
}

/**
 * A control-plane hook. Implement `before`, `after`, or both. Pass one — or an
 * array — to {@link ../core.createAuditCore} via `hooks`.
 */
export interface AuditHooks {
  /**
   * Runs before a mutation commits. **Throw to deny** (the error propagates to
   * the caller; its message is the reason). Return/resolve to allow. Must not
   * mutate the event payload.
   */
  before?(event: BeforeEvent): void | Promise<void>;
  /**
   * Runs after a mutation commits. For side effects only. Errors are isolated
   * and reported via `onHookError` — they never fail the (already committed)
   * operation.
   */
  after?(event: AfterEvent): void | Promise<void>;
}

/** Accepts a single hook, an array, or nothing. */
export type AuditHooksInput = AuditHooks | readonly AuditHooks[] | undefined;

/** Reports an error thrown by an `after` hook. */
export type HookErrorReporter = (error: unknown, event: AfterEvent) => void;

/** Normalize the `hooks` option into a flat array (empty when unset). */
export function normalizeHooks(input: AuditHooksInput): AuditHooks[] {
  if (!input) return [];
  return Array.isArray(input) ? [...input] : [input as AuditHooks];
}

/**
 * Run every `before` hook sequentially, in order. The first hook to throw
 * aborts: the error propagates to the caller (denying the mutation) and no
 * later hook runs. A no-op when there are no `before` hooks.
 */
export async function runBefore(hooks: AuditHooks[], event: BeforeEvent): Promise<void> {
  for (const hook of hooks) {
    if (hook.before) await hook.before(event);
  }
}

/**
 * Run every `after` hook, isolating failures. The mutation has already
 * committed, so a throwing hook must not fail the operation — its error is
 * routed to `onError` and swallowed. Remaining hooks still run.
 */
export async function runAfter(
  hooks: AuditHooks[],
  event: AfterEvent,
  onError: HookErrorReporter,
): Promise<void> {
  await Promise.all(
    hooks.map(async (hook) => {
      if (!hook.after) return;
      try {
        await hook.after(event);
      } catch (error) {
        onError(error, event);
      }
    }),
  );
}

/** Default `after`-hook error reporter: warn, but never throw. */
export const defaultHookErrorReporter: HookErrorReporter = (error, event) => {
  // eslint-disable-next-line no-console
  console.warn(`[@xtandard/audit] after-hook for "${event.type}" threw:`, error);
};
