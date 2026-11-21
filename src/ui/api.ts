import type {
  ActionDefinition,
  ApiError,
  AuditCheckpoint,
  AuditConfig,
  AuditEvent,
  AuditPage,
  AuditSection,
  AuditTenant,
  ExportFormat,
  Overview,
  StreamStatus,
  VerifyReport,
} from "./types.ts";
import { AuditApiError } from "./types.ts";

// Base prepended to every request path. Empty by default so the bundled SPA uses
// relative URLs (resolved against the injected <base href>). The React component
// export sets this to the panel's mount URL via setApiBase().
let apiBase = "";
// Credentials mode for every request. `same-origin` (default) is right for the
// bundled SPA and same-origin embeds; a cross-origin embed (panel on another
// origin) must use `include` so the session cookie is sent. See setApiBase().
let apiCredentials: RequestCredentials = "same-origin";
// Optional custom fetch (e.g. to inject a bearer token / extra headers when the
// panel is protected by a non-cookie scheme). Defaults to the global fetch.
let apiFetch: FetchLike = (input, init) => fetch(input, init);
// Portal token attached as `Authorization: Bearer audpt_…` to every request.
// Set by the standalone SPA when a `?token=` query param is present (the portal
// embed mechanism for the bundled UI) or by the React portal component.
let apiToken: string | null = null;

/** The subset of `fetch` the client uses (the global `fetch` satisfies it). */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Options for {@link setApiBase}. */
export interface ApiClientOptions {
  /** `credentials` mode for requests. Use `"include"` for cross-origin cookie auth. */
  credentials?: RequestCredentials;
  /** Custom fetch implementation (bearer tokens, extra headers, instrumentation). */
  fetch?: FetchLike;
}

/** Point the API client at a base URL (used by the `@xtandard/audit/react` export). */
export function setApiBase(base: string, opts?: ApiClientOptions): void {
  apiBase = base.replace(/\/$/, "");
  if (opts?.credentials) apiCredentials = opts.credentials;
  if (opts?.fetch) apiFetch = opts.fetch;
}

/** Attach a portal token (`audpt_…`) as a Bearer credential on every request. */
export function setApiToken(token: string | null): void {
  apiToken = token;
}

/** The URL for an API path under the current base (links: JWKS, OpenAPI). */
export function apiUrl(path: string): string {
  return apiBase ? `${apiBase}/${path}` : path;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  const res = await apiFetch(apiUrl(path), {
    credentials: apiCredentials,
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: ApiError;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      body = { status: res.status, error: res.statusText };
    }
    throw new AuditApiError(res.status, { ...body, status: res.status });
  }
  return res;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

const tenantBase = (tenant: string): string => `api/tenants/${encodeURIComponent(tenant)}`;

/** `?a=1&b=2` from defined, non-empty params (`""` when none). */
export const toSearch = (params: { [key: string]: string | number | undefined }): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
};

/* ─── Config ────────────────────────────────────────────────────────────────── */

export function getConfig(): Promise<AuditConfig> {
  return req<AuditConfig>("config");
}

export function getOverview(): Promise<Overview> {
  return req<Overview>("api/overview");
}

/* ─── Tenants ───────────────────────────────────────────────────────────────── */

export function listTenants(): Promise<AuditTenant[]> {
  return req<AuditTenant[]>("api/tenants");
}

export function getTenant(tenant: string): Promise<AuditTenant> {
  return req<AuditTenant>(tenantBase(tenant));
}

/* ─── Events ────────────────────────────────────────────────────────────────── */

/** API query parameters for listing/exporting (see `toApiQuery` in lib/filters.ts). */
export type EventQueryParams = Record<string, string>;

/**
 * One page of events. With a `tenant` the tenant-scoped route is used;
 * without, the cross-tenant listing (admin only).
 */
export function listEvents(
  tenant: string | undefined,
  params: EventQueryParams,
  page: { cursor?: string; limit?: number } = {},
): Promise<AuditPage<AuditEvent>> {
  const path = tenant ? `${tenantBase(tenant)}/events` : "api/events";
  return req<AuditPage<AuditEvent>>(`${path}${toSearch({ ...params, ...page })}`);
}

export function getEvent(tenant: string, id: string): Promise<AuditEvent> {
  return req<AuditEvent>(`${tenantBase(tenant)}/events/${encodeURIComponent(id)}`);
}

export function eraseEvent(
  tenant: string,
  id: string,
  input: { sections?: AuditSection[]; reason?: string },
): Promise<AuditEvent> {
  return req<AuditEvent>(`${tenantBase(tenant)}/events/${encodeURIComponent(id)}/erase`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Fetch an export as a Blob. A plain `<a href>` cannot carry the portal
 * token's `Authorization` header, so the UI downloads through the API client
 * and hands the browser an object URL.
 */
export async function exportEvents(
  tenant: string,
  format: ExportFormat,
  params: EventQueryParams,
): Promise<{ blob: Blob; contentDisposition: string | null }> {
  const res = await send(`${tenantBase(tenant)}/export${toSearch({ ...params, format })}`);
  return { blob: await res.blob(), contentDisposition: res.headers.get("content-disposition") };
}

/* ─── Integrity ─────────────────────────────────────────────────────────────── */

export function verifyTenant(
  tenant: string,
  range: { fromSeq?: number; toSeq?: number } = {},
): Promise<VerifyReport> {
  return req<VerifyReport>(`${tenantBase(tenant)}/verify${toSearch(range)}`);
}

export function listCheckpoints(tenant: string): Promise<AuditCheckpoint[]> {
  return req<AuditCheckpoint[]>(`${tenantBase(tenant)}/checkpoints`);
}

export function createCheckpoint(tenant: string): Promise<AuditCheckpoint> {
  return req<AuditCheckpoint>(`${tenantBase(tenant)}/checkpoints`, { method: "POST" });
}

/** Public JWKS URL (checkpoint verification keys). */
export const jwksUrl = (): string => apiUrl("api/integrity/keys");

/* ─── Action catalog ────────────────────────────────────────────────────────── */

export function listActions(): Promise<ActionDefinition[]> {
  return req<ActionDefinition[]>("api/actions");
}

export function updateAction(
  name: string,
  input: Omit<ActionDefinition, "name" | "source" | "createdAt" | "updatedAt">,
): Promise<ActionDefinition> {
  return req<ActionDefinition>(`api/actions/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteAction(name: string): Promise<void> {
  return req<void>(`api/actions/${encodeURIComponent(name)}`, { method: "DELETE" });
}

/* ─── Streams ───────────────────────────────────────────────────────────────── */

export function listStreams(): Promise<StreamStatus[]> {
  return req<StreamStatus[]>("api/streams");
}

export function retryStream(name: string, tenant?: string): Promise<void> {
  return req<void>(`api/streams/${encodeURIComponent(name)}/retry${toSearch({ tenant })}`, {
    method: "POST",
  });
}
