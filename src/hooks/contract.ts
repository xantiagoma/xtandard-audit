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

import {
  createHookErrorReporter,
  type HookErrorReporter as KitHookErrorReporter,
  type Hooks,
  type HooksInput,
} from "@xtandard/kit/hooks";
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

export { HookDeniedError, normalizeHooks, runAfter, runBefore } from "@xtandard/kit/hooks";

/**
 * A control-plane hook. Implement `before` (runs before a mutation commits;
 * **throw to deny**, e.g. a `HookDeniedError` with a clean HTTP status),
 * `after` (side effects once it committed; errors are isolated and reported via
 * `onHookError`), or both. Pass one — or an array — to
 * {@link ../core.createAuditCore} via `hooks`.
 */
export type AuditHooks = Hooks<BeforeEvent, AfterEvent>;

/** Accepts a single hook, an array, or nothing. */
export type AuditHooksInput = HooksInput<BeforeEvent, AfterEvent>;

/** Reports an error thrown by an `after` hook. */
export type HookErrorReporter = KitHookErrorReporter<AfterEvent>;

/** Default `after`-hook error reporter: `console.warn` with the `[@xtandard/audit]` prefix. */
export const defaultHookErrorReporter: HookErrorReporter =
  createHookErrorReporter("@xtandard/audit");
