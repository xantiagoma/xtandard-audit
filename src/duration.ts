/**
 * Duration parsing for {@link ./schema.AuditDuration} config values. Zero
 * dependencies; shared by the core (retention, checkpoint intervals) and the
 * stream runner (retry backoff).
 *
 * @module
 */

import {
  durationToMs as kitDurationToMs,
  parseDurationList as kitParseDurationList,
} from "@xtandard/kit/util";
import type { AuditDuration } from "./schema.ts";

/**
 * Convert a duration (`"5s"`, `"30m"`, `"2h"`, `"7d"`, or a number of
 * milliseconds) to milliseconds. Throws on malformed strings or negative /
 * non-finite numbers.
 */
export function durationToMs(duration: AuditDuration): number {
  return kitDurationToMs(duration);
}

/**
 * Parse a comma-separated list of durations (`"0,30s,5m,1h"`). Bare numbers
 * become milliseconds; every item is validated eagerly, so a bad list fails at
 * parse time.
 */
export function parseDurationList(input: string): AuditDuration[] {
  return kitParseDurationList(input) as AuditDuration[];
}
