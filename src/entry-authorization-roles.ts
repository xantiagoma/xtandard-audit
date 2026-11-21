/**
 * Role-based authorization: `rolesAuthorization()` maps role names to the
 * actions they grant (built-in `admin`/`auditor`/`viewer` policy by default),
 * with a `readonly` switch that denies every mutating action.
 *
 * Import from `@xtandard/audit/authorization/roles`.
 *
 * @module authorization/roles
 */

export * from "./authorization/roles.ts";
