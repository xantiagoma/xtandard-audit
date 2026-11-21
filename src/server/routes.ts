/**
 * JSON admin API (the contract is `docs/HTTP_API.md`). A tiny method+pattern
 * router over {@link AuditCore}, wired to authentication, authorization, and
 * portal-token scoping. Returns `null` for non-API paths so the caller can fall
 * through to static-asset / SPA handling.
 *
 * The customer **portal** is not a separate route set — a request bearing a
 * valid `Authorization: Bearer audpt_…` token hits this same API force-scoped
 * to the token's tenant, its allowed actions, and its view filter (the host's
 * own auth/authorization providers are bypassed for portal principals; portal
 * scoping wins, ADR 0006).
 *
 * @module
 */

import {
  authenticate,
  authorize as authorizeWith,
  error,
  intParam as kitIntParam,
  json,
  mapError as kitMapError,
  match,
  noContent,
  type ErrorMap,
} from "@xtandard/kit/server";
import type { AuthProvider, Principal } from "../auth/contract.ts";
import {
  ALL_ACTIONS,
  isMutatingAction,
  type AuthorizationProvider,
  type AuditAction,
  type AuditResource,
} from "../authorization/contract.ts";
import type { AuditCore, EraseInput } from "../core.ts";
import { EXPORT_CONTENT_TYPES, exportEvents, type ExportFormat } from "../export.ts";
import type { HookActor } from "../hooks/contract.ts";
import {
  DEFAULT_PORTAL_ACTIONS,
  PORTAL_TOKEN_PREFIX,
  portalCanSee,
  scopeQueryToPortal,
  verifyPortalToken,
  type PortalGrant,
} from "../portal.ts";
import { QueryError } from "../query.ts";
import type {
  ActionDefinition,
  AuditEventInput,
  AuditOutcome,
  AuditPage,
  AuditQuery,
} from "../schema.ts";
import type { StreamRunner } from "../streams.ts";
import { TENANT_REGEX, ValidationError } from "../validation.ts";
import { buildOpenApiDocument } from "./openapi.ts";

export { DEFAULT_PORTAL_ACTIONS };

/**
 * Portal composition for the panel: when set, requests bearing a valid
 * `audpt_…` token act as a portal principal scoped to the token's tenant and
 * view filter.
 */
export interface AuditPortalOptions {
  /** The HMAC secret portal tokens are minted with (`createPortalToken`). */
  secret: string;
  /**
   * Actions a portal principal may perform (always confined to the token's
   * tenant). Defaults to {@link DEFAULT_PORTAL_ACTIONS}.
   */
  allow?: AuditAction[];
}

/** The bootstrap config served at `/config` (and injected into the SPA). */
export interface PanelConfig {
  title: string;
  basePath: string;
  readonly: boolean;
  logoUrl?: string;
  /** True for portal-token principals: the UI renders the portal chrome. */
  portal: boolean;
  /** The portal principal's tenant. */
  tenant?: string;
  principal: { id: string; name?: string; email?: string } | null;
  /** Actions this principal may perform (the UI hides what it cannot do). */
  allowed: AuditAction[];
  features: { signer: boolean; streams: boolean };
}

/** Everything the API router needs. */
export interface ApiContext {
  core: AuditCore;
  auth: AuthProvider;
  authorization: AuthorizationProvider;
  title: string;
  readonly: boolean;
  basePath: string;
  logoUrl?: string;
  /** Portal-token composition (see {@link AuditPortalOptions}). */
  portal?: AuditPortalOptions;
  /** The panel's stream runner (status + retry routes), or `null`. */
  streams: StreamRunner | null;
}

const EMPTY_PAGE: AuditPage = { items: [], pageInfo: { hasNextPage: false, endCursor: null } };

const EXPORT_FORMATS: readonly ExportFormat[] = ["csv", "json", "jsonl", "bundle"];

/** File extension per export format (the bundle is JSONL with a distinguishing suffix). */
const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  csv: "csv",
  json: "json",
  jsonl: "jsonl",
  bundle: "bundle.jsonl",
};

/**
 * Path parameters are re-validated before they reach storage: the native event
 * tables store tenants and event ids raw, and MySQL's PAD SPACE collation would
 * match `"acme "` to `"acme"`. A tenant or id that could never have been
 * recorded is simply not found.
 */
const isTenant = (tenant: string): boolean =>
  tenant.length <= 128 && TENANT_REGEX.test(tenant) && !/^\.+$/.test(tenant);
const EVENT_ID = /^evt_[0-9A-Za-z]{1,64}$/;

/** The control-plane actor for a principal (hooks + self-audit attribution). */
function actorFor(principal: Principal): HookActor {
  return {
    id: principal.id,
    ...(principal.email !== undefined ? { email: principal.email } : {}),
    ...(principal.name !== undefined ? { name: principal.name } : {}),
  };
}

/** Read a list param: repeated (`?a=x&a=y`) and/or comma-separated (`?a=x,y`). */
function listParam(params: URLSearchParams, name: string): string[] | undefined {
  const values = params
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

/** Read an integer param; throws {@link QueryError} on a malformed value. */
function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  try {
    return kitIntParam(raw, { invalid: "throw", positive: false, name });
  } catch {
    throw new QueryError(`Invalid ${name}: ${raw}`);
  }
}

/** The query model as URL parameters (docs/HTTP_API.md "Query parameters"). */
export function parseQueryParams(params: URLSearchParams): AuditQuery {
  const q: AuditQuery = {};
  const actions = listParam(params, "actions");
  if (actions) q.actions = actions;
  const excludeActions = listParam(params, "excludeActions");
  if (excludeActions) q.excludeActions = excludeActions;
  for (const k of ["tenant", "actorId", "actorType", "targetType", "targetId"] as const) {
    const v = params.get(k);
    if (v) q[k] = v;
  }
  if (q.tenant !== undefined && !isTenant(q.tenant)) {
    throw new QueryError(`Invalid tenant: ${q.tenant}`);
  }
  const outcome = params.get("outcome");
  if (outcome) {
    if (outcome !== "success" && outcome !== "failure")
      throw new QueryError(`Invalid outcome: ${outcome}`);
    q.outcome = outcome as AuditOutcome;
  }
  for (const k of ["from", "to", "search", "cursor"] as const) {
    const v = params.get(k);
    if (v) q[k] = v;
  }
  const order = params.get("order");
  if (order) {
    if (order !== "asc" && order !== "desc") throw new QueryError(`Invalid order: ${order}`);
    q.order = order;
  }
  const limit = intParam(params, "limit");
  if (limit !== undefined) {
    if (limit < 1 || limit > 500) throw new QueryError("Invalid limit: expected 1–500");
    q.limit = limit;
  }
  return q;
}

/** `attachment; filename="<tenant>-audit-<date>.<ext>"`, with a filesystem-safe tenant. */
export function exportFilename(tenant: string, format: ExportFormat, now: number): string {
  const safe = tenant.replace(/[^a-zA-Z0-9._-]/g, "_");
  const date = new Date(now).toISOString().slice(0, 10);
  return `${safe}-audit-${date}.${EXPORT_EXTENSIONS[format]}`;
}

/** Read an optional JSON body (empty body → `fallback`). */
async function optionalBody<T>(request: Request, fallback: T): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return fallback;
  return JSON.parse(text) as T;
}

/**
 * Handle an API request. `path` is already base-path-stripped. Returns a
 * `Response` for API/config routes, or `null` if the path is not an API route.
 */
export async function handleApiRequest(
  request: Request,
  path: string,
  ctx: ApiContext,
): Promise<Response | null> {
  const isApi =
    path === "/config" ||
    path === "/api/config" ||
    path === "/openapi.json" ||
    path === "/api" ||
    path.startsWith("/api/");
  if (!isApi) return null;

  const method = request.method.toUpperCase();
  const url = new URL(request.url);

  // Public OpenAPI document (no auth) — for docs tooling and host-app merging.
  if (path === "/api/openapi.json" || path === "/openapi.json") {
    return json(buildOpenApiDocument({ basePath: ctx.basePath, title: ctx.title }));
  }

  // Public verification keys (no auth, CORS-open) — so auditors can verify
  // checkpoints and export bundles against the operator's published keys.
  if (path === "/api/integrity/keys" && method === "GET") {
    return json(await ctx.core.jwks(), 200, {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    });
  }

  // --- Authentication ---
  // A portal token short-circuits the host's providers entirely: valid →
  // portal-scoped principal; invalid/expired → 401 (never fall back to the
  // host's auth with an explicitly presented, rejected credential). A throwing
  // auth provider is a backend failure (IdP down, DB error) — surfaced as 500,
  // not a misleading 401.
  const portal = ctx.portal;
  let who: Awaited<ReturnType<typeof authenticate<PortalGrant>>>;
  try {
    who = await authenticate<PortalGrant>(request, {
      auth: ctx.auth,
      ...(portal
        ? {
            scoped: {
              prefix: PORTAL_TOKEN_PREFIX,
              verify: (token) => verifyPortalToken(portal.secret, token),
              principal: (g) => ({
                id: `portal:${g.tenant}`,
                metadata: {
                  portal: true,
                  tenant: g.tenant,
                  ...(g.filter ? { filter: g.filter } : {}),
                },
              }),
            },
          }
        : {}),
    });
  } catch (err) {
    return mapError(err);
  }
  const { principal } = who;
  const grant = who.scoped;
  const portalAllow: ReadonlySet<AuditAction> = new Set(
    grant ? (portal?.allow ?? DEFAULT_PORTAL_ACTIONS) : [],
  );

  /** Portal scoping: the token's tenant, its allowed actions, read-only global catalog. */
  const portalPermits = (action: AuditAction, resource: AuditResource): boolean => {
    if (!grant || !portalAllow.has(action)) return false;
    switch (resource.type) {
      // The action catalog is global, shared by every tenant: read-only for
      // portals even if the host widened `portal.allow` to catalog writes.
      case "action":
        return action === "action:read";
      // Streams are operator infrastructure, never a tenant's concern.
      case "stream":
        return false;
      default:
        return resource.tenant === grant.tenant;
    }
  };

  const decide = async (action: AuditAction, resource: AuditResource): Promise<boolean> => {
    if (!principal) return false;
    return authorizeWith(
      who,
      { action, resource, request },
      { authorization: ctx.authorization, scope: (_grant, a, r) => portalPermits(a, r) },
    );
  };

  // Public bootstrap config: who is signed in, what they may do, portal chrome.
  if (path === "/config" || path === "/api/config") {
    const allowed: AuditAction[] = [];
    for (const action of ALL_ACTIONS) {
      if (ctx.readonly && isMutatingAction(action)) continue;
      const resource = configResource(action, grant?.tenant);
      try {
        if (await decide(action, resource)) allowed.push(action);
      } catch {
        // A throwing provider grants nothing here; the real route will 500.
      }
    }
    const config: PanelConfig = {
      title: ctx.title,
      basePath: ctx.basePath,
      readonly: ctx.readonly,
      ...(ctx.logoUrl !== undefined ? { logoUrl: ctx.logoUrl } : {}),
      portal: grant !== null,
      ...(grant ? { tenant: grant.tenant } : {}),
      principal: principal
        ? {
            id: principal.id,
            ...(principal.name !== undefined ? { name: principal.name } : {}),
            ...(principal.email !== undefined ? { email: principal.email } : {}),
          }
        : null,
      allowed,
      features: {
        signer: ctx.core.options.signer !== undefined,
        streams: (ctx.streams?.streams.length ?? 0) > 0,
      },
    };
    return json(config);
  }

  if (principal === null) {
    const challenge = ctx.auth.challenge?.(request);
    return challenge ?? error(401, "Unauthorized");
  }

  const authorize = async (
    action: AuditAction,
    resource: AuditResource,
  ): Promise<Response | null> => {
    if (ctx.readonly && isMutatingAction(action)) {
      return error(423, "The audit panel is readonly", { code: "READONLY", action });
    }
    return (await decide(action, resource)) ? null : error(403, "Forbidden", { action });
  };

  const actor = actorFor(principal);
  const opts = { actor };

  /** Run a (possibly portal-scoped) query. */
  const runQuery = async (query: AuditQuery): Promise<AuditPage> => {
    if (!grant) return ctx.core.query(query);
    const scoped = scopeQueryToPortal(query, grant);
    return scoped.empty ? EMPTY_PAGE : ctx.core.query(scoped.query);
  };

  try {
    // Key-shaped path parameters (see `isTenant`): unknown, never a storage hit on a
    // near-spelling. Recording keeps the core's own 422 for an invalid tenant.
    const tenantPath = /^\/api\/tenants\/[^/]+/.exec(path)?.[0];
    const keyed = tenantPath ? match("/api/tenants/:tenant", tenantPath) : null;
    const recording = method === "POST" && path === `${tenantPath}/events`;
    if (keyed && !recording && !isTenant(keyed.tenant!)) {
      return error(404, `tenant "${keyed.tenant}" not found`);
    }
    const event =
      match("/api/tenants/:tenant/events/:id", path) ??
      match("/api/tenants/:tenant/events/:id/erase", path);
    if (event && !EVENT_ID.test(event.id!)) return error(404, `event "${event.id}" not found`);

    // --- Overview ---
    if (path === "/api/overview" && method === "GET") {
      const denied = await authorize("tenant:read", { type: "tenant" });
      if (denied) return denied;
      const tenants = await ctx.core.listTenants();
      const recent = await ctx.core.query({ limit: 10 });
      return json({
        tenants: tenants.length,
        events: tenants.reduce((sum, t) => sum + (t.count ?? 0), 0),
        recent: recent.items,
        streams: ctx.streams ? await ctx.streams.status() : [],
      });
    }

    // --- Tenants ---
    if (path === "/api/tenants" && method === "GET") {
      const denied = await authorize("tenant:read", { type: "tenant" });
      if (denied) return denied;
      return json(await ctx.core.listTenants());
    }

    let m = match("/api/tenants/:tenant", path);
    if (m && method === "GET") {
      const tenant = m.tenant!;
      const denied = await authorize("tenant:read", { type: "tenant", tenant });
      if (denied) return denied;
      const head = await ctx.core.head(tenant);
      if (head.seq === 0) return error(404, `tenant "${tenant}" not found`);
      // A filtered portal must not learn how many events it cannot see.
      const count = grant?.filter ? undefined : await ctx.core.count(tenant);
      return json({ key: tenant, head, ...(count !== undefined ? { count } : {}) });
    }

    // --- Events ---
    if (path === "/api/events" && method === "GET") {
      const query = parseQueryParams(url.searchParams);
      const tenant = grant ? grant.tenant : query.tenant;
      const denied = await authorize("event:read", {
        type: "event",
        ...(tenant !== undefined ? { tenant } : {}),
      });
      if (denied) return denied;
      return json(await runQuery(query));
    }

    m = match("/api/tenants/:tenant/events", path);
    if (m) {
      const tenant = m.tenant!;
      if (method === "GET") {
        const denied = await authorize("event:read", { type: "event", tenant });
        if (denied) return denied;
        return json(await runQuery({ ...parseQueryParams(url.searchParams), tenant }));
      }
      if (method === "POST") {
        const denied = await authorize("event:record", { type: "event", tenant });
        if (denied) return denied;
        const body = (await request.json()) as unknown;
        const many = Array.isArray(body);
        const inputs = (many ? body : [body]) as Partial<AuditEventInput>[];
        const issues = inputs.flatMap((input, i) =>
          input === null || typeof input !== "object" || Array.isArray(input)
            ? [{ path: many ? `[${i}]` : "event", message: "expected an object" }]
            : input.tenant !== undefined && input.tenant !== tenant
              ? [
                  {
                    path: many ? `[${i}].tenant` : "event.tenant",
                    message: `does not match the path tenant "${tenant}"`,
                  },
                ]
              : [],
        );
        if (issues.length) throw new ValidationError(issues);
        // The actor defaults to the authenticated principal (an ingest service).
        const prepared = inputs.map((input) => ({
          ...input,
          tenant,
          actor: input.actor ?? { ...actor, type: "api" },
        })) as AuditEventInput[];
        const events = many
          ? await ctx.core.recordMany(prepared)
          : [await ctx.core.record(prepared[0]!)];
        return json(many ? events : events[0], 201);
      }
    }

    m = match("/api/tenants/:tenant/events/:id", path);
    if (m && method === "GET") {
      const { tenant, id } = m as { tenant: string; id: string };
      const denied = await authorize("event:read", { type: "event", tenant, eventId: id });
      if (denied) return denied;
      const event = await ctx.core.get(tenant, id);
      if (!event || (grant && !portalCanSee(event, grant)))
        return error(404, `event "${id}" not found`);
      return json(event);
    }

    m = match("/api/tenants/:tenant/events/:id/erase", path);
    if (m && method === "POST") {
      const { tenant, id } = m as { tenant: string; id: string };
      const denied = await authorize("event:erase", { type: "event", tenant, eventId: id });
      if (denied) return denied;
      const input = await optionalBody<EraseInput>(request, {});
      return json(await ctx.core.erase(tenant, id, input, opts));
    }

    // --- Export ---
    m = match("/api/tenants/:tenant/export", path);
    if (m && method === "GET") {
      const tenant = m.tenant!;
      const denied = await authorize("event:export", { type: "event", tenant });
      if (denied) return denied;
      const params = new URLSearchParams(url.searchParams);
      const format = (params.get("format") ?? "csv") as ExportFormat;
      if (!EXPORT_FORMATS.includes(format)) {
        return error(400, `Invalid format: expected one of ${EXPORT_FORMATS.join(", ")}`);
      }
      params.delete("format");
      let query: AuditQuery = { ...parseQueryParams(params), tenant };
      delete query.cursor;
      delete query.limit;
      if (grant) {
        // A bundle is the whole chain (that is what makes it verifiable), so a
        // filtered view cannot have one.
        if (format === "bundle" && grant.filter) {
          return error(403, "Bundle exports are not available to filtered portal tokens", {
            action: "event:export",
          });
        }
        const scoped = scopeQueryToPortal(query, grant);
        query = scoped.query;
        // Outside the token's view: an empty window (`from` inclusive, `to` exclusive).
        if (scoped.empty)
          query = { ...query, from: new Date(0).toISOString(), to: new Date(0).toISOString() };
      }
      const stream = await exportEvents(ctx.core, query, { format, ...opts });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": EXPORT_CONTENT_TYPES[format],
          "content-disposition": `attachment; filename="${exportFilename(tenant, format, ctx.core.options.now())}"`,
          "cache-control": "no-store",
        },
      });
    }

    // --- Integrity ---
    m = match("/api/tenants/:tenant/verify", path);
    if (m && method === "GET") {
      const tenant = m.tenant!;
      const denied = await authorize("integrity:read", { type: "integrity", tenant });
      if (denied) return denied;
      const fromSeq = intParam(url.searchParams, "fromSeq");
      const toSeq = intParam(url.searchParams, "toSeq");
      return json(
        await ctx.core.verify(tenant, {
          ...(fromSeq !== undefined ? { fromSeq } : {}),
          ...(toSeq !== undefined ? { toSeq } : {}),
        }),
      );
    }

    m = match("/api/tenants/:tenant/checkpoints", path);
    if (m) {
      const tenant = m.tenant!;
      if (method === "GET") {
        const denied = await authorize("integrity:read", { type: "integrity", tenant });
        if (denied) return denied;
        return json(await ctx.core.listCheckpoints(tenant));
      }
      if (method === "POST") {
        const denied = await authorize("integrity:checkpoint", { type: "integrity", tenant });
        if (denied) return denied;
        return json(await ctx.core.checkpoint(tenant, opts), 201);
      }
    }

    // --- Retention ---
    m = match("/api/tenants/:tenant/prune", path);
    if (m && method === "POST") {
      const tenant = m.tenant!;
      const denied = await authorize("retention:prune", { type: "retention", tenant });
      if (denied) return denied;
      return json(await ctx.core.pruneTenant(tenant, opts));
    }

    if (path === "/api/prune" && method === "POST") {
      const denied = await authorize("retention:prune", { type: "retention" });
      if (denied) return denied;
      return json(await ctx.core.prune(opts));
    }

    // --- Action catalog ---
    if (path === "/api/actions" && method === "GET") {
      const denied = await authorize("action:read", { type: "action" });
      if (denied) return denied;
      return json(await ctx.core.listActions());
    }

    m = match("/api/actions/:name", path);
    if (m) {
      const name = m.name!;
      if (method === "PUT") {
        const denied = await authorize("action:update", { type: "action", name });
        if (denied) return denied;
        const input = (await request.json()) as ActionDefinition;
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          throw new ValidationError([{ path: "action", message: "expected an object" }]);
        }
        return json(await ctx.core.upsertAction({ ...input, name }, opts));
      }
      if (method === "DELETE") {
        const denied = await authorize("action:delete", { type: "action", name });
        if (denied) return denied;
        await ctx.core.deleteAction(name, opts);
        return noContent();
      }
    }

    // --- Streams ---
    if (path === "/api/streams" && method === "GET") {
      const denied = await authorize("stream:read", { type: "stream" });
      if (denied) return denied;
      return json(ctx.streams ? await ctx.streams.status() : []);
    }

    m = match("/api/streams/:name/retry", path);
    if (m && method === "POST") {
      const name = m.name!;
      const denied = await authorize("stream:retry", { type: "stream", name });
      if (denied) return denied;
      if (!ctx.streams?.streams.some((s) => s.name === name)) {
        return error(404, `stream "${name}" not found`);
      }
      const tenant = url.searchParams.get("tenant") ?? undefined;
      await ctx.streams.retry(name, tenant);
      return noContent();
    }

    return error(404, "Not found");
  } catch (err) {
    return mapError(err);
  }
}

/**
 * The resource `/config` asks the authorization provider about for each
 * action: the "listing" resource (no tenant / name), the portal's tenant for
 * portal principals, and `tenant: "*"` for `integrity`, whose resource always
 * names a tenant.
 */
function configResource(action: AuditAction, tenant: string | undefined): AuditResource {
  const type = action.split(":")[0] as AuditResource["type"];
  switch (type) {
    case "integrity":
      return { type, tenant: tenant ?? "*" };
    case "action":
    case "stream":
      return { type };
    default:
      return tenant ? { type, tenant } : { type };
  }
}

/**
 * The audit error contract (docs/HTTP_API.md "Errors"). Errors are mapped by
 * `name`, so a class copy from another bundle still maps; `HookDeniedError`
 * (its own status, `HOOK_DENIED`) is the kit's built-in.
 */
const ERROR_MAP: ErrorMap = {
  ReadonlyError: { status: 423, code: "READONLY" },
  PortalTokenError: { status: 401, code: "PORTAL_TOKEN" },
  QueryError: { status: 400, code: "BAD_QUERY" },
  NotFoundError: { status: 404 },
  SignerRequiredError: { status: 409, code: "SIGNER_REQUIRED" },
  ConflictError: { status: 409, code: "CONFLICT" },
  ChainConflictError: { status: 409, code: "CONFLICT" },
  ValidationError: {
    status: 422,
    code: "VALIDATION",
    extra: (e) => {
      const errors = (e as { errors?: unknown }).errors;
      return { errors: Array.isArray(errors) ? errors : [] };
    },
  },
  SyntaxError: () => error(400, "Invalid JSON body", { code: "BAD_JSON" }),
};

/** Map domain errors to HTTP responses (docs/HTTP_API.md "Errors"). */
export function mapError(err: unknown): Response {
  return kitMapError(err, ERROR_MAP);
}
