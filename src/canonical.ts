/**
 * Canonical JSON serialization: object keys sorted recursively, no whitespace,
 * so two values that are structurally equal produce byte-identical output
 * regardless of key insertion order or storage round-trips (Postgres `jsonb`
 * and some BSON paths reorder keys).
 *
 * This is the byte format the integrity hashes are computed over (ADR 0004).
 * For the value shapes audit events allow — strings, finite numbers, booleans,
 * null, arrays, plain objects — it matches RFC 8785 (JCS) for integers and
 * strings; non-finite numbers are rejected rather than silently becoming `null`.
 *
 * @module
 */

import type { JsonValue } from "./schema.ts";

/**
 * Serialize a JSON value with object keys sorted lexicographically at every
 * depth. Arrays keep their order; `undefined` inside objects is dropped exactly
 * as `JSON.stringify` would. Throws on non-finite numbers.
 *
 * @example
 * ```ts
 * canonicalStringify({ b: 1, a: 2 }) === canonicalStringify({ a: 2, b: 1 }); // true
 * ```
 */
export function canonicalStringify(value: JsonValue | undefined): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`canonicalStringify: non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const entries = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}
