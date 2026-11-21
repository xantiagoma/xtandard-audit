/**
 * Shared fixtures for the panel/route/adapter tests: a memory-backed panel and
 * small request helpers.
 *
 * @module
 */

import {
  createFetchHandler,
  type AuditPanelOptions,
  type CreateFetchHandlerResult,
} from "../src/server/create-fetch-handler.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

export const BASE = "http://panel.test/audit";

/** A memory-backed panel under `/audit` (maintenance off unless asked). */
export function makePanel(options: Partial<AuditPanelOptions> = {}): CreateFetchHandlerResult {
  return createFetchHandler({
    storage: createMemoryStorage(),
    basePath: "/audit",
    maintenance: false,
    ...options,
  });
}

/** Build a request against the panel. */
export function req(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    ...(init.body !== undefined
      ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }
      : {}),
  });
}

/** Call the panel and parse JSON (null for empty bodies). */
export async function call<T = unknown>(
  panel: { fetch(r: Request): Promise<Response> },
  path: string,
  init: Parameters<typeof req>[1] = {},
): Promise<{ status: number; body: T; res: Response }> {
  const res = await panel.fetch(req(path, init));
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T, res };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A standard event input for tenant routes. */
export const evt = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  actor: { id: "u1", name: "Ada" },
  ...extra,
});
