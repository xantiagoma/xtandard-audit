/**
 * Runtime validation for record inputs and control-plane inputs, built on
 * `valibot` (like the sibling packages). Action-specific `metadata` is validated
 * separately by the host's Standard Schema validators (ADR 0012).
 *
 * @module
 */

import { issuesFrom, jsonValueSchema, type ValidationResult } from "@xtandard/kit/util";
import * as v from "valibot";
import type { AuditEventInput } from "./schema.ts";

export {
  assertValid,
  ValidationError,
  type ValidationIssue,
  type ValidationResult,
} from "@xtandard/kit/util";

/** Allowed characters for tenant keys. */
export const TENANT_REGEX = /^[a-zA-Z0-9_.:@-]+$/;
/** Allowed characters for action names (`invoice.paid`, `member:role_changed`). */
export const ACTION_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
/** Maximum serialized size of one event's free-form sections, in bytes. Default for `maxEventBytes`. */
export const DEFAULT_MAX_EVENT_BYTES = 65_536;

const jsonObjectSchema = v.record(v.string(), jsonValueSchema);

const tenantSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(TENANT_REGEX, "must match " + String(TENANT_REGEX)),
  v.check((s) => !/^\.+$/.test(s), "must not be only dots"),
);

const actionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(ACTION_REGEX, "must match " + String(ACTION_REGEX)),
);

const idString = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

const actorSchema = v.object({
  id: idString,
  type: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  name: v.optional(v.pipe(v.string(), v.maxLength(256))),
  email: v.optional(v.pipe(v.string(), v.maxLength(320))),
  metadata: v.optional(jsonObjectSchema),
});

const targetSchema = v.object({
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  id: idString,
  name: v.optional(v.pipe(v.string(), v.maxLength(256))),
  metadata: v.optional(jsonObjectSchema),
});

const isoOrDate = v.union([
  v.date(),
  v.pipe(
    v.string(),
    v.check((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 timestamp"),
  ),
]);

const eventInputSchema = v.object({
  id: v.optional(v.pipe(v.string(), v.regex(/^evt_[0-9A-Za-z]{1,64}$/, "must look like evt_…"))),
  tenant: tenantSchema,
  action: actionSchema,
  occurredAt: v.optional(isoOrDate),
  actor: v.optional(actorSchema),
  targets: v.optional(v.pipe(v.array(targetSchema), v.maxLength(64))),
  context: v.optional(jsonObjectSchema),
  metadata: v.optional(jsonObjectSchema),
  outcome: v.optional(v.picklist(["success", "failure"])),
  description: v.optional(v.pipe(v.string(), v.maxLength(2048))),
});

const actionDefinitionSchema = v.object({
  name: actionSchema,
  description: v.optional(v.pipe(v.string(), v.maxLength(2048))),
  group: v.optional(v.pipe(v.string(), v.maxLength(128))),
  targets: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64)))),
  schema: v.optional(jsonValueSchema),
  deprecated: v.optional(v.boolean()),
  source: v.optional(v.picklist(["code", "ui"])),
  createdAt: v.optional(v.string()),
  updatedAt: v.optional(v.string()),
});

/** Validate a tenant key. */
export function validateTenant(tenant: unknown, basePath = "tenant"): ValidationResult {
  const r = v.safeParse(tenantSchema, tenant);
  return r.success
    ? { valid: true, errors: [] }
    : { valid: false, errors: issuesFrom(r.issues, basePath) };
}

/**
 * Validate the structure of a record input (not the action's metadata schema).
 *
 * @example
 * ```ts
 * import { validateEventInput } from "@xtandard/audit";
 *
 * validateEventInput({ tenant: "acme", action: "invoice.paid", actor: { id: "u_1" } }).valid; // true
 * ```
 */
export function validateEventInput(
  input: unknown,
  options: { maxEventBytes?: number; basePath?: string } = {},
): ValidationResult {
  const basePath = options.basePath ?? "event";
  const r = v.safeParse(eventInputSchema, input);
  if (!r.success) return { valid: false, errors: issuesFrom(r.issues, basePath) };
  const e = input as AuditEventInput;
  const max = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const size = new TextEncoder().encode(
    JSON.stringify([e.actor, e.targets, e.context, e.metadata, e.description]),
  ).length;
  if (size > max) {
    return {
      valid: false,
      errors: [{ path: basePath, message: `event is ${size} bytes; the limit is ${max}` }],
    };
  }
  return { valid: true, errors: [] };
}

/** Validate an action catalog entry. */
export function validateActionDefinition(input: unknown, basePath = "action"): ValidationResult {
  const r = v.safeParse(actionDefinitionSchema, input);
  return r.success
    ? { valid: true, errors: [] }
    : { valid: false, errors: issuesFrom(r.issues, basePath) };
}
