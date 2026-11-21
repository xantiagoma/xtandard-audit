/**
 * Vendored [Standard Schema v1](https://standardschema.dev) types (type-only,
 * zero runtime) plus the action-map helpers that give `record()` its compile-time
 * typing (ADR 0012). Any compliant validator works: valibot, zod, arktype,
 * effect schema, …
 *
 * @module
 */

import type { AuditOutcome, JsonObject, JsonValue } from "./schema.ts";

/** The Standard Schema v1 interface (vendored, type-only). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["input"];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}

/** One action's definition in code. */
export interface ActionSpec<
  TMetadata extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  /** Validator for `metadata` (any Standard Schema). Omit for untyped metadata. */
  metadata?: TMetadata;
  description?: string;
  /** UI grouping label. */
  group?: string;
  /** Target types this action carries (documentation; enforced when `strictTargets`). */
  targets?: string[];
  /** JSON-Schema-ish description of `metadata` for the UI catalog. */
  schema?: JsonValue;
  /** Default outcome when the caller does not pass one. */
  outcome?: AuditOutcome;
  deprecated?: boolean;
}

/** A map of action name → spec. */
export type ActionMap = Record<string, ActionSpec>;

/** The `metadata` input type of one action. */
export type ActionMetadataInput<TSpec> =
  TSpec extends ActionSpec<infer S>
    ? S extends StandardSchemaV1
      ? StandardSchemaV1.InferInput<S>
      : JsonObject
    : JsonObject;

/**
 * Declare the typed action catalog. Identity at runtime; preserves the literal
 * types so `core.record()` can infer action names and metadata shapes.
 *
 * @example
 * ```ts
 * import * as v from "valibot";
 * import { createAuditCore, defineActions } from "@xtandard/audit";
 *
 * const actions = defineActions({
 *   "invoice.paid": {
 *     metadata: v.object({ invoiceId: v.string(), amount: v.number() }),
 *     targets: ["invoice"],
 *     description: "An invoice was paid",
 *   },
 *   "member.removed": { targets: ["user"] },
 * });
 *
 * const audit = createAuditCore({ storage, actions });
 * await audit.record({
 *   tenant: "acme",
 *   action: "invoice.paid", // ← autocompletes; typos are compile errors
 *   actor: { id: "user_1" },
 *   metadata: { invoiceId: "inv_1", amount: 4200 }, // ← typed
 * });
 * ```
 */
export function defineActions<const T extends ActionMap>(actions: T): T {
  return actions;
}

/** Run a Standard Schema validator; returns the output or the issue messages. */
export async function runStandardSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<{ ok: true; value: T } | { ok: false; issues: { path: string; message: string }[] }> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    return {
      ok: false,
      issues: result.issues.map((i) => ({
        path: (i.path ?? [])
          .map((p) => (typeof p === "object" && p !== null ? String(p.key) : String(p)))
          .join("."),
        message: i.message,
      })),
    };
  }
  return { ok: true, value: result.value };
}
