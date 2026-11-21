/**
 * Authorization contract. Answers: "Can this principal perform this action on
 * this resource?"
 *
 * Every admin API route consults the {@link AuthorizationProvider} (portal
 * principals excepted — their token's scope is the whole grant). Ships
 * `none`/`roles`/`delegated` implementations.
 *
 * @module
 */

import type { Principal } from "../auth/contract.ts";

/** The full set of authorizable actions. */
export type AuditAction =
  | "tenant:read"
  | "event:read"
  | "event:record"
  | "event:export"
  | "event:erase"
  | "integrity:read"
  | "integrity:checkpoint"
  | "action:read"
  | "action:update"
  | "action:delete"
  | "retention:prune"
  | "stream:read"
  | "stream:retry";

/**
 * The resource an action targets. An absent `tenant` / `name` means "across
 * all" (listings, the cross-tenant event search, a global prune).
 */
export type AuditResource =
  | { type: "tenant"; tenant?: string }
  | { type: "event"; tenant?: string; eventId?: string }
  | { type: "integrity"; tenant: string }
  | { type: "action"; name?: string }
  | { type: "retention"; tenant?: string }
  | { type: "stream"; name?: string };

/** Input passed to {@link AuthorizationProvider.authorize}. */
export interface AuthorizeInput {
  principal: Principal | null;
  action: AuditAction;
  resource: AuditResource;
  request: Request;
}

/** Decides whether an action is permitted. */
export interface AuthorizationProvider {
  authorize(input: AuthorizeInput): Promise<boolean>;
}

/** Every action, in a stable order (the UI and `/config` `allowed` use it). */
export const ALL_ACTIONS: readonly AuditAction[] = [
  "tenant:read",
  "event:read",
  "event:record",
  "event:export",
  "event:erase",
  "integrity:read",
  "integrity:checkpoint",
  "action:read",
  "action:update",
  "action:delete",
  "retention:prune",
  "stream:read",
  "stream:retry",
];

/** Actions that mutate state — blocked (`423`) when the panel is readonly. */
export const MUTATING_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  "event:record",
  "event:erase",
  "integrity:checkpoint",
  "action:update",
  "action:delete",
  "retention:prune",
  "stream:retry",
]);

/** True if the action mutates state. */
export const isMutatingAction = (action: AuditAction): boolean => MUTATING_ACTIONS.has(action);
