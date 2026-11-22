/**
 * Role-based {@link AuthorizationProvider}. Maps each role name to the set of
 * {@link AuditAction}s it grants, then allows an action when *any* of the
 * principal's roles grants it.
 *
 * The policy is a flat `Record<roleName, AuditAction[] | "*">` — `"*"` is a
 * wildcard granting every action. When no `policy` is supplied, the built-in
 * {@link DEFAULT_ROLE_POLICY} applies (`admin`/`auditor`/`viewer`).
 *
 * A `readonly` switch denies every {@link isMutatingAction mutating} action
 * regardless of role — handy for read-only mirrors or "break glass" lockdowns.
 *
 * @module
 */

import {
  rolesAuthorization as kitRoles,
  type RolePolicy as KitRolePolicy,
} from "@xtandard/kit/authorization/roles";
import {
  ALL_ACTIONS,
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditResource,
  type AuthorizationProvider,
} from "./contract.ts";

export { ALL_ACTIONS };

export const READ_ACTIONS: readonly AuditAction[] = ALL_ACTIONS.filter((a) => a.endsWith(":read"));

/**
 * What an auditor needs: every read, exporting events, and signing checkpoints
 * — but no erasure, retention, catalog edits or stream control.
 */
export const AUDITOR_ACTIONS: readonly AuditAction[] = [
  ...READ_ACTIONS,
  "event:export",
  "integrity:checkpoint",
];

/** A role policy: each role maps to an explicit action list or the `"*"` wildcard. */
export type RolePolicy = KitRolePolicy<AuditAction>;

/**
 * The default role policy applied when {@link RolesAuthorizationOptions.policy}
 * is omitted.
 *
 * - `admin` — `"*"`, every action.
 * - `auditor` — every read, plus `event:export` and `integrity:checkpoint`.
 * - `viewer` — every `*:read` action only.
 */
export const DEFAULT_ROLE_POLICY: RolePolicy = {
  admin: "*",
  auditor: [...AUDITOR_ACTIONS],
  viewer: [...READ_ACTIONS],
};

/** Options for {@link rolesAuthorization}. */
export interface RolesAuthorizationOptions {
  /**
   * Role → granted actions. `"*"` grants everything. Defaults to
   * {@link DEFAULT_ROLE_POLICY} when omitted.
   */
  policy?: RolePolicy;
  /**
   * When `true`, every {@link isMutatingAction mutating} action is denied
   * regardless of the principal's roles.
   * @default false
   */
  readonly?: boolean;
}

/**
 * Create a role-based {@link AuthorizationProvider}.
 *
 * Decision order:
 * 1. If `readonly` and the action mutates → **deny**.
 * 2. If the principal is `null` → **deny**.
 * 3. If any of the principal's roles grants the action (via `"*"` or an explicit
 *    list) → **allow**; otherwise **deny**.
 *
 * @example
 * ```ts
 * import { rolesAuthorization } from "@xtandard/audit/authorization/roles";
 *
 * // Built-in admin/auditor/viewer policy:
 * const authz = rolesAuthorization();
 *
 * // Custom policy:
 * const custom = rolesAuthorization({
 *   policy: {
 *     support: ["tenant:read", "event:read"],
 *     compliance: ["event:read", "event:export", "event:erase"],
 *   },
 * });
 * ```
 */
export function rolesAuthorization(options: RolesAuthorizationOptions = {}): AuthorizationProvider {
  return kitRoles<AuditAction, AuditResource>({
    policy: options.policy ?? DEFAULT_ROLE_POLICY,
    actions: AUDIT_ACTIONS,
    readonly: options.readonly,
  });
}
