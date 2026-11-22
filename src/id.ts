/**
 * Time-sortable ids (ADR 0010): `{prefix}_` + 26 Crockford base32 characters —
 * 48 bits of unix milliseconds followed by 80 random bits, ULID-compatible.
 * Monotonic within a process: ids minted in the same millisecond increment the
 * random part, so lexicographic order equals creation order. The generator is
 * `@xtandard/kit/util`'s `createIdGenerator({ format: "ulid" })` (taken from
 * this file).
 *
 * @module
 */

import { createIdGenerator } from "@xtandard/kit/util";

/** Id prefixes: events and checkpoints. */
export type IdPrefix = "evt" | "chk";

const ids = createIdGenerator<IdPrefix>({ format: "ulid", prefixes: ["evt", "chk"] });

/** A new id, e.g. `newId("evt")` → `"evt_01JD…"`. `ms` overrides the clock for this id. */
export function newId(prefix: IdPrefix, ms?: number): string {
  return ids.newId(prefix, ms);
}

/** The regex an id with `prefix` must match. */
export function idPattern(prefix: IdPrefix): RegExp {
  return ids.idPattern(prefix);
}

/** The unix-ms timestamp embedded in an id, or `null` when malformed. */
export function idTime(id: string): number | null {
  return ids.idTime(id);
}
