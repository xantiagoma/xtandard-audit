/**
 * Time-sortable ids (ADR 0010): `{prefix}_` + 26 Crockford base32 characters —
 * 48 bits of unix milliseconds followed by 80 random bits, ULID-compatible.
 * Monotonic within a process: ids minted in the same millisecond increment the
 * random part, so lexicographic order equals creation order. Zero dependencies.
 *
 * @module
 */

/** Prefixes for the generated id kinds. */
export type IdPrefix = "evt" | "chk";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  let value = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b % 32);
}

/** Increment a base32 digit array by one (carry to the left). */
function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i] = next[i]! + 1;
      return next;
    }
    next[i] = 0;
  }
  // 80 bits exhausted within one millisecond: astronomically unlikely; restart.
  return randomDigits();
}

/** A raw 26-char time-sortable value for `ms` (defaults to now). */
export function sortableId(ms: number = Date.now()): string {
  // Injected clocks may return fractional milliseconds; the encoding needs an integer.
  ms = Math.floor(ms);
  let random: number[];
  if (ms <= lastTime) {
    random = increment(lastRandom);
    ms = lastTime;
  } else {
    random = randomDigits();
    lastTime = ms;
  }
  lastRandom = random;
  return encodeTime(ms) + random.map((d) => ENCODING[d]).join("");
}

/**
 * Generate a new id, e.g. `newId("evt")` → `"evt_01JD…"`.
 *
 * @example
 * ```ts
 * import { newId } from "@xtandard/audit";
 *
 * const id = newId("evt"); // "evt_01JD3Z…" — sorts by creation time
 * ```
 */
export function newId(prefix: IdPrefix, ms?: number): string {
  return `${prefix}_${sortableId(ms)}`;
}

/** Regex an id of the given prefix must match. */
export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
}

/** Decode the millisecond timestamp embedded in a time-sortable id, or `null`. */
export function idTime(id: string): number | null {
  const raw = id.slice(id.indexOf("_") + 1, id.indexOf("_") + 1 + TIME_LEN);
  if (raw.length !== TIME_LEN) return null;
  let ms = 0;
  for (const ch of raw) {
    const d = ENCODING.indexOf(ch);
    if (d === -1) return null;
    ms = ms * 32 + d;
  }
  return ms;
}
