/**
 * `@xtandard/audit/hooks/log` — a reference hook that logs mutation events.
 *
 * The simplest possible consumer of the hooks seam: useful as a starting point
 * for your own `after` side effects, and handy for local debugging or piping
 * admin activity to a log aggregator. Zero dependencies.
 *
 * @example
 * ```ts
 * import { createAuditCore } from "@xtandard/audit";
 * import { createLogHook } from "@xtandard/audit/hooks/log";
 *
 * createAuditCore({ storage, hooks: createLogHook() });
 * ```
 *
 * @module
 */

import * as kit from "@xtandard/kit/hooks/log";
import type { AfterEvent, AuditHooks, BeforeEvent } from "./contract.ts";

/**
 * Options for {@link createLogHook}: `log` (default `console.log`),
 * `includeBefore` (default `false` — `after` only), `json` (one JSON object
 * per line), `describe` (an extra text-format field) and `format` (replaces
 * the whole line; default `[@xtandard/audit] <phase> <type> <json>`).
 */
export type LogHookOptions = kit.LogHookOptions<BeforeEvent, AfterEvent>;

/**
 * Build a hook that logs each mutation event. Never throws from `before`, so it
 * never denies a mutation — it is a pure observer.
 */
export function createLogHook(options: LogHookOptions = {}): AuditHooks {
  return kit.createLogHook<BeforeEvent, AfterEvent>({ source: "@xtandard/audit", ...options });
}
