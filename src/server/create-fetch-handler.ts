/**
 * The web-standard fetch handler at the heart of every framework adapter and the
 * standalone app. Composes auth/authorization (plus portal-token scoping), the
 * JSON admin API, static-asset serving, and SPA fallback into a single
 * `(request: Request) => Promise<Response>` — and, by default, starts the
 * stream runner (when `streams` are declared) and the retention maintenance
 * timer, so mounting the panel is all it takes to operate the log.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuthProvider } from "../auth/contract.ts";
import type { AuthorizationProvider } from "../authorization/contract.ts";
import { createAuditCore, type AuditCore, type RetentionOptions } from "../core.ts";
import { durationToMs } from "../duration.ts";
import type { HookErrorReporter, AuditHooksInput } from "../hooks/contract.ts";
import type { AuditSigner } from "../integrity.ts";
import type { AuditDuration } from "../schema.ts";
import type { ActionMap } from "../standard-schema.ts";
import type { AuditStorage } from "../storage/contract.ts";
import {
  createStreamRunner,
  type StreamDefinition,
  type StreamRunner,
  type StreamRunnerOptions,
} from "../streams.ts";
import type { AuditTransform } from "../transforms.ts";
import { normalizeBasePath, stripBasePath } from "./base-path.ts";
import { applyCorsHeaders, preflightResponse, type AuditCorsOptions } from "./cors.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { renderIndexHtml } from "./render-index-html.ts";
import { handleApiRequest, type ApiContext, type AuditPortalOptions } from "./routes.ts";
import { looksLikeAsset, serveStaticAsset } from "./static-assets.ts";

/** Options for the panel handler (shared by every framework adapter). */
export interface AuditPanelOptions {
  /**
   * Where the log lives. Required unless a prebuilt `core` is supplied (which
   * carries its own storage as the source of truth).
   */
  storage?: AuditStorage;
  /** Mount prefix, e.g. `"/audit"`. Default `""` (root). */
  basePath?: string;
  /** Authentication provider. Default: anonymous (no auth). */
  auth?: AuthProvider;
  /** Authorization provider. Default: allow all. */
  authorization?: AuthorizationProvider;
  /**
   * Portal-token composition: requests bearing a valid `audpt_…` token act as a
   * portal principal scoped to the token's tenant and view filter. Mint tokens
   * server-side with `createPortalToken`. See {@link ./routes.AuditPortalOptions}.
   */
  portal?: AuditPortalOptions;
  /** Block all mutating operations (`423`) when true. */
  readonly?: boolean;
  /** UI title shown in the page and bootstrap config. */
  title?: string;
  /** Logo image URL shown in the navbar in place of the title wordmark. */
  logoUrl?: string;
  /** Override the directory the bundled UI is served from (defaults to `./ui` beside this module). */
  uiDir?: string;
  /**
   * Reuse an existing core instead of constructing one — typed
   * (`createAuditCore({ actions })`) or not. The panel only records untyped
   * input over HTTP (validated at runtime by the core's catalog), so any action
   * map is accepted here.
   */
  // oxlint-disable-next-line no-explicit-any -- a typed core's `record` is narrower than ActionMap's
  core?: AuditCore<any>;
  /**
   * Control-plane hooks (see {@link ../hooks/contract.AuditHooks}). Ignored
   * when `core` is supplied — configure hooks on that core instead.
   */
  hooks?: AuditHooksInput;
  /** Reporter for errors thrown by `after` hooks. Default: `console.warn`. Ignored with `core`. */
  onHookError?: HookErrorReporter;
  /**
   * Retention policy (see {@link ../core.RetentionOptions}). Ignored when a
   * prebuilt `core` is supplied — configure it on that core instead. Pruning
   * runs on the `maintenance` timer and via `POST /api/prune`.
   */
  retention?: RetentionOptions;
  /** Checkpoint signer (`ed25519Signer` / `hmacSigner`). Ignored with `core`. */
  signer?: AuditSigner;
  /** Typed action catalog from `defineActions`. Ignored with `core`. */
  actions?: ActionMap;
  /** Redact / mask / hash / omit before chaining. Ignored with `core`. */
  transforms?: AuditTransform[];
  /**
   * Enable CORS on the handler itself — answers `OPTIONS` preflights and attaches
   * `Access-Control-*` headers to every response, so a **cross-origin** portal
   * embed works regardless of the host framework. See {@link ./cors.AuditCorsOptions}.
   */
  cors?: AuditCorsOptions;
  /**
   * SIEM / archive streams (ADR 0008). The panel creates a stream runner over
   * them (status + retry in the UI) and **starts** it unless `streamRunner`
   * is `false`.
   */
  streams?: StreamDefinition[];
  /**
   * Stream-runner tuning, or `false` to not start it in this process
   * (split deployments where `xtandard-audit serve` elsewhere runs the
   * streams). The runner is still created so the UI shows lag and errors.
   */
  streamRunner?: Omit<StreamRunnerOptions, "streams"> | false;
  /**
   * Periodic retention: run `core.prune()` every `interval` (default `"1h"`)
   * when the core has a `retention` policy. `false` disables the timer
   * (prune from a cron with `xtandard-audit prune` instead).
   */
  maintenance?: { interval?: AuditDuration } | false;
}

/** Return shape of {@link createFetchHandler}. */
export interface CreateFetchHandlerResult {
  /** Web-standard request handler. */
  fetch(request: Request): Promise<Response>;
  /** The underlying core (handy for `record()`, tests, CLI, and standalone wiring). */
  core: AuditCore<ActionMap>;
  /** The stream runner (started unless `streamRunner: false`), or `null` without `streams`. */
  streams: StreamRunner | null;
  /**
   * The admin API as an OpenAPI 3.1 document (also served at `{basePath}/api/openapi.json`).
   * Merge it into your host app's docs — e.g. Elysia `@elysiajs/openapi` `references`.
   */
  openapi(): Record<string, unknown>;
  /** Stop the stream runner and the maintenance timer (graceful shutdown, tests). */
  close(): Promise<void>;
}

// Anonymous defaults keep embedded usage zero-config; harden via auth/authorization.
const defaultAuth: AuthProvider = { authenticate: async () => ({ id: "anonymous" }) };
const defaultAuthorization: AuthorizationProvider = { authorize: async () => true };

/**
 * Locate the built admin SPA (`dist/ui`). When this module runs compiled (the
 * normal npm-consumer case) it lives in `dist/` and the bundle is the sibling
 * `./ui`. When it runs from TypeScript source (examples / dev against a
 * `file:`-linked checkout, where the runtime executes `src/server/*.ts`
 * directly), the bundle is instead at `<repo>/dist/ui` — i.e. `../../dist/ui`
 * relative to `src/server/`. Try the candidates and return the first that
 * exists, falling back to the compiled-layout path so the "build the UI" hint
 * still fires when nothing is built yet.
 */
function defaultUiDir(): string {
  try {
    const candidates = [
      new URL("./ui", import.meta.url), // compiled: dist/<chunk>.mjs → dist/ui
      new URL("../../dist/ui", import.meta.url), // source: src/server/*.ts → <repo>/dist/ui
    ].map((u) => fileURLToPath(u));
    return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  } catch {
    return "./ui";
  }
}

/**
 * Build the panel fetch handler.
 *
 * @example
 * ```ts
 * import { createFetchHandler, ed25519Signer } from "@xtandard/audit";
 * import { createMemoryStorage } from "@xtandard/audit/storage/memory";
 *
 * const { fetch, core } = createFetchHandler({
 *   storage: createMemoryStorage(),
 *   basePath: "/audit",
 *   title: "Acme Audit Log",
 *   signer: await ed25519Signer(JSON.parse(process.env.AUDIT_SIGNING_KEY!)),
 *   retention: { maxAge: "365d" },
 * });
 *
 * Bun.serve({ port: 3000, fetch });
 * // Elsewhere in the app:
 * await core.record({ tenant: "acme", action: "invoice.paid", actor: { id: "user_1" } });
 * ```
 */
export function createFetchHandler(options: AuditPanelOptions): CreateFetchHandlerResult {
  const basePath = normalizeBasePath(options.basePath);
  const readonly = options.readonly ?? false;
  const title = options.title ?? "@xtandard/audit";
  const uiDir = options.uiDir ?? defaultUiDir();

  // Either a prebuilt `core` (its own source of truth for storage) or a
  // `storage` to build one from is required.
  if (!options.core && !options.storage) {
    throw new Error("createFetchHandler requires either `storage` or a prebuilt `core`. Pass one.");
  }

  const core: AuditCore<ActionMap> =
    options.core ??
    createAuditCore({
      storage: options.storage!,
      readonly,
      ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
      ...(options.onHookError ? { onHookError: options.onHookError } : {}),
      ...(options.retention ? { retention: options.retention } : {}),
      ...(options.signer ? { signer: options.signer } : {}),
      ...(options.actions ? { actions: options.actions } : {}),
      ...(options.transforms ? { transforms: options.transforms } : {}),
    });

  // The panel owns the default embedded deployment shape: the stream runner
  // created AND started (timers are unref()ed — it never keeps the process alive).
  let streams: StreamRunner | null = null;
  if (options.streams?.length) {
    const runnerOptions = options.streamRunner === false ? {} : (options.streamRunner ?? {});
    streams = createStreamRunner(core, { ...runnerOptions, streams: options.streams });
    if (options.streamRunner !== false) streams.start();
  }

  // Retention maintenance: prune on a timer when the core has a policy.
  let maintenance: ReturnType<typeof setInterval> | null = null;
  if (options.maintenance !== false && core.options.retention && !readonly) {
    const intervalMs = durationToMs(options.maintenance?.interval ?? "1h");
    maintenance = setInterval(() => {
      core.prune().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[@xtandard/audit] scheduled prune failed:", err);
      });
    }, intervalMs);
    (maintenance as { unref?: () => void }).unref?.();
  }

  const apiCtx: ApiContext = {
    core,
    auth: options.auth ?? defaultAuth,
    authorization: options.authorization ?? defaultAuthorization,
    title,
    readonly,
    basePath,
    streams,
    ...(options.logoUrl !== undefined ? { logoUrl: options.logoUrl } : {}),
    ...(options.portal ? { portal: options.portal } : {}),
  };

  const cors = options.cors;

  async function fetch(request: Request): Promise<Response> {
    // CORS preflight: answer OPTIONS directly so it works for any path,
    // independent of the host framework wrapping this handler.
    if (cors && request.method === "OPTIONS") return preflightResponse(request, cors);
    const response = await respond(request);
    return cors ? applyCorsHeaders(request, response, cors) : response;
  }

  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = stripBasePath(url.pathname, basePath);

    // 1. JSON API + bootstrap config.
    const api = await handleApiRequest(request, path, apiCtx);
    if (api) return api;

    // 2. Only GET/HEAD reach the static UI.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 3. Static asset.
    const asset = await serveStaticAsset(uiDir, path);
    if (asset) return asset;

    // 4. A path that looks like a file but was not found → 404 (don't mask with the SPA).
    if (path !== "/" && looksLikeAsset(path)) {
      return new Response("Not Found", { status: 404 });
    }

    // 5. SPA fallback.
    const html = await renderIndexHtml(uiDir, {
      title,
      basePath,
      readonly,
      ...(options.logoUrl !== undefined ? { logoUrl: options.logoUrl } : {}),
    });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return {
    fetch,
    core,
    streams,
    openapi: () => buildOpenApiDocument({ basePath, title }),
    async close() {
      if (maintenance) clearInterval(maintenance);
      maintenance = null;
      await streams?.stop();
    },
  };
}
