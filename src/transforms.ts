/**
 * Transforms run on every event **before** it is chained and stored, so the
 * hash covers exactly what is kept: redact, mask, hash, or omit sensitive
 * values. Ported from `drizzle-audit`'s transforms, generalized from row columns
 * to dotted paths over the whole event (ADR 0009).
 *
 * Paths address the event: `"metadata.password"`, `"context.ip"`,
 * `"actor.email"`, `"targets.*.name"` (`*` matches any key or array index).
 *
 * @example
 * ```ts
 * import { createAuditCore, redact, mask, hashValue, omit } from "@xtandard/audit";
 *
 * const audit = createAuditCore({
 *   storage,
 *   transforms: [
 *     redact("metadata.password", "metadata.token"),
 *     mask("actor.email"),
 *     hashValue("context.ip"),
 *     omit("metadata.rawRequest"),
 *   ],
 * });
 * ```
 *
 * @module
 */

import type { AuditEvent, JsonValue } from "./schema.ts";
import { sha256 } from "./integrity.ts";

/** The event shape transforms see: fully resolved, not yet chained. */
export type TransformableEvent = Omit<AuditEvent, "integrity" | "seq" | "recordedAt"> & {
  recordedAt?: string;
};

/** A transform: sync or async, returns the (possibly new) event. */
export type AuditTransform = (
  event: TransformableEvent,
) => TransformableEvent | Promise<TransformableEvent>;

/** Replacement value used by {@link redact}. */
export const REDACTED = "[REDACTED]";

type Mapper = (value: JsonValue) => JsonValue | undefined | Promise<JsonValue | undefined>;

/** Apply `fn` to every value at `path` (dot-separated, `*` wildcard); `undefined` deletes. */
async function mapPath(root: unknown, segments: string[], fn: Mapper): Promise<void> {
  if (root === null || typeof root !== "object" || segments.length === 0) return;
  const [head, ...rest] = segments as [string, ...string[]];
  const container = root as Record<string, unknown>;
  const keys = head === "*" ? Object.keys(container) : [head];
  for (const key of keys) {
    if (!(key in container)) continue;
    if (rest.length > 0) {
      await mapPath(container[key], rest, fn);
      continue;
    }
    const current = container[key];
    if (current === undefined || current === null) continue;
    const next = await fn(current as JsonValue);
    if (next === undefined) {
      if (Array.isArray(container)) container.splice(Number(key), 1);
      else delete container[key];
    } else container[key] = next;
  }
}

function pathTransform(paths: string[], fn: Mapper): AuditTransform {
  const split = paths.map((p) => p.split("."));
  return async (event) => {
    const copy = structuredClone(event);
    for (const segments of split) await mapPath(copy, segments, fn);
    return copy;
  };
}

/** Replace the values at `paths` with `"[REDACTED]"`. */
export function redact(...paths: string[]): AuditTransform {
  return pathTransform(paths, () => REDACTED);
}

/** Remove the values at `paths` entirely. */
export function omit(...paths: string[]): AuditTransform {
  return pathTransform(paths, () => undefined);
}

/**
 * Partially mask string values: emails become `j***@e***.com`, short strings
 * `****`, longer strings keep their last four characters.
 */
export function mask(...paths: string[]): AuditTransform {
  return pathTransform(paths, (value) => maskValue(String(value)));
}

/** The masking used by {@link mask}. */
export function maskValue(str: string): string {
  if (str.includes("@")) {
    const [local, domain] = str.split("@");
    if (local && domain) {
      const parts = domain.split(".");
      const maskedDomain =
        (parts[0]?.[0] ?? "") + "***" + (parts.length > 1 ? "." + parts[parts.length - 1] : "");
      return `${local[0]}***@${maskedDomain}`;
    }
  }
  if (str.length <= 4) return "****";
  return "*".repeat(str.length - 4) + str.slice(-4);
}

/**
 * Replace values with a SHA-256 digest (`sha256:…`). Pass a `salt` (a secret)
 * to keep low-entropy values (emails, IPs) from being confirmed by brute force;
 * equal inputs still produce equal digests, so you can correlate without storing.
 */
export function hashValue(
  paths: string | string[],
  options: { salt?: string } = {},
): AuditTransform {
  const salt = options.salt ?? "";
  return pathTransform(Array.isArray(paths) ? paths : [paths], (value) =>
    sha256(`${salt}${typeof value === "string" ? value : JSON.stringify(value)}`),
  );
}

/** Run transforms in order. */
export async function applyTransforms(
  event: TransformableEvent,
  transforms: readonly AuditTransform[],
): Promise<TransformableEvent> {
  let current = event;
  for (const t of transforms) current = await t(current);
  return current;
}
