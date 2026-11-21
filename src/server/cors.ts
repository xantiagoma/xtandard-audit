/**
 * Framework-independent CORS for the mounted panel. When `auditPanel` /
 * `createFetchHandler` is given a `cors` option, the handler answers `OPTIONS`
 * preflights itself and attaches `Access-Control-*` headers to every response —
 * so a **cross-origin embed** (portal on `app.example.com`, panel on
 * `api.example.com`) works even if the host framework's CORS middleware does not
 * wrap the mounted sub-handler.
 *
 * @module
 */

import type { CorsOptions } from "@xtandard/kit/server";

/**
 * CORS for the panel: `origin` (a string, a list, or a predicate; `"*"` with
 * `credentials` echoes the caller's origin), `credentials`, `methods`,
 * `headers` and `maxAge`.
 */
export type AuditCorsOptions = CorsOptions;
