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
import { createApiClient, type ApiClient } from "@xtandard/kit/ui";
import { AuditApiError } from "./types.ts";

/**
 * The audit API client (`@xtandard/kit/ui`'s): a base URL (empty by default,
 * so the bundled SPA uses relative URLs resolved against the injected
 * `<base href>`; the React export sets the panel's mount URL), the
 * `credentials` mode (`"include"` for a cross-origin cookie embed), an
 * optional custom `fetch`, and the portal token sent as
 * `Authorization: Bearer audpt_…`. Non-2xx responses throw
 * {@link AuditApiError}. Each product has its own client, so two dashboards on
 * one page never share a base URL or token.
 */
const client = createApiClient({ errorClass: AuditApiError });

export type { ApiClientOptions, FetchLike } from "@xtandard/kit/ui";

/** Point the API client at a base URL (used by the `@xtandard/audit/react` export). */
export const setApiBase: ApiClient["setApiBase"] = client.setApiBase;

/** Attach a portal token (`audpt_…`) as a Bearer credential on every request. */
export const setApiToken: ApiClient["setApiToken"] = client.setApiToken;

/** The attached portal token, if any. */
export const getApiToken: ApiClient["getApiToken"] = client.getApiToken;

/** The URL for an API path under the current base (links: JWKS, OpenAPI). */
export const apiUrl: ApiClient["apiUrl"] = client.apiUrl;

const send = client.send;
const req = client.req;

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
