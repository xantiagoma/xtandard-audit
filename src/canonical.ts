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
 * The implementation is `@xtandard/kit/util`'s `canonicalStringify` (taken from
 * this file; the output is byte-identical — `test/integrity.test.ts` pins it).
 *
 * @module
 */

import { canonicalStringify as kitCanonicalStringify } from "@xtandard/kit/util";
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
  return kitCanonicalStringify(value);
}
