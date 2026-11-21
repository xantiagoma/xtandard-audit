/**
 * UI-facing types. Entity shapes are re-exported from the package schema and
 * spine modules (types only — safe to bundle); the UI adds the bootstrap
 * config, overview, API-error, and filter types the JSON admin API serves
 * (see docs/HTTP_API.md).
 */

export type {
  ActionDefinition,
  AuditActor,
  AuditCheckpoint,
  AuditContext,
  AuditEvent,
  AuditOutcome,
  AuditPage,
  AuditSection,
  AuditTarget,
  AuditTenant,
  ChainHead,
  JsonObject,
  JsonValue,
} from "../schema.ts";
export type { VerifyIssue, VerifyIssueKind, VerifyReport } from "../integrity.ts";
export type { StreamStatus } from "../streams.ts";

import type { AuditEvent } from "../schema.ts";
import type { StreamStatus } from "../streams.ts";

/**
 * An authorization action the panel checks (`event:read`, `event:erase`, …).
 * The UI hides what `/config.allowed` does not list. Kept as an open string
 * union so a newer server's actions don't break an older bundle.
 */
export type PanelAction =
  | "tenant:read"
  | "event:read"
  | "event:record"
  | "event:erase"
  | "event:export"
  | "integrity:read"
  | "integrity:checkpoint"
  | "retention:prune"
  | "action:read"
  | "action:update"
  | "action:delete"
  | "stream:read"
  | "stream:retry"
  | (string & {});

/** Bootstrap config injected as `window.__AUDIT_CONFIG__` and served at `/config`. */
export interface AuditConfig {
  title: string;
  basePath: string;
  readonly: boolean;
  logoUrl?: string;
  /** True for portal-token principals: the UI renders the portal chrome. */
  portal?: boolean;
  /** The portal principal's tenant. */
  tenant?: string;
  principal?: { id: string; name?: string; email?: string } | null;
  /**
   * Actions this principal may perform (the UI hides what it cannot do).
   * Absent (older server / bare bootstrap) → everything is shown and the server
   * stays the enforcement point.
   */
  allowed?: PanelAction[];
  features?: { signer: boolean; streams: boolean };
}

/** `GET /api/overview`. */
export interface Overview {
  tenants: number;
  events: number;
  /** Latest events across tenants (newest first). */
  recent: AuditEvent[];
  streams: StreamStatus[];
}

/** Export formats served by `GET /api/tenants/:tenant/export`. */
export type ExportFormat = "csv" | "json" | "jsonl" | "bundle";

export interface ApiError {
  status: number;
  error: string;
  code?: string;
  errors?: { path?: string; message: string }[];
}

export class AuditApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.error);
    this.name = "AuditApiError";
  }
}
