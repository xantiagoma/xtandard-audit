/**
 * Pure UI helpers — no React, no DOM. Unit-tested in `test/ui-lib.test.ts`
 * (visual behavior is covered by the Playwright e2e suite instead).
 *
 * @module
 */

import type {
  ActionDefinition,
  AuditActor,
  AuditCheckpoint,
  AuditConfig,
  AuditEvent,
  AuditSection,
  AuditTarget,
  ExportFormat,
  PanelAction,
  StreamStatus,
  VerifyReport,
} from "../types.ts";

/** Absolute date-time, locale-aware. Returns `"—"` for missing/invalid input. */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/**
 * Compact relative time: `"just now"`, `"5m ago"`, `"in 2h"`, `"3d ago"`.
 * `now` is injectable for tests; defaults to the current time.
 */
export function relativeTime(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const diff = now - at;
  const abs = Math.abs(diff);
  if (abs < 10_000) return "just now";
  const units: [number, string][] = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
  ];
  let value = Math.round(abs / 1000);
  let unit = "s";
  for (const [ms, label] of units) {
    if (abs >= ms) {
      value = Math.round(abs / ms);
      unit = label;
    }
  }
  return diff >= 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
}

/** Thousands-separated integer; `"—"` for missing input. */
export function formatCount(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

/** Truncate with an ellipsis; never longer than `max` (including the ellipsis). */
export function truncate(text: string, max: number): string {
  if (max <= 1) return text.length > max ? "…" : text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Shorten a `sha256:<hex>` digest for tables: keeps the algorithm prefix and
 * the first `chars` hex digits. Non-prefixed strings are truncated as-is.
 */
export function shortHash(hash: string | null | undefined, chars = 12): string {
  if (!hash) return "—";
  const [alg, hex] = hash.includes(":") ? hash.split(":", 2) : ["", hash];
  const body = hex ?? "";
  const short = body.length > chars ? `${body.slice(0, chars)}…` : body;
  return alg ? `${alg}:${short}` : short;
}

/* ─── Permissions ──────────────────────────────────────────────────────────── */

/**
 * Whether the principal may perform `action`, per `/config.allowed`. A config
 * without `allowed` (older server, bare bootstrap) allows everything — the
 * server stays the enforcement point; the UI only hides what it knows is denied.
 */
export function can(
  config: Pick<AuditConfig, "allowed"> | undefined,
  action: PanelAction,
): boolean {
  const allowed = config?.allowed;
  if (!allowed) return true;
  return allowed.includes(action);
}

/* ─── Events ───────────────────────────────────────────────────────────────── */

/** Primary display label for an actor: name, then email, then id. */
export function actorLabel(actor: AuditActor | undefined | null): string {
  if (!actor || isErasedValue(actor)) return "—";
  return actor.name || actor.email || actor.id || "—";
}

/** One target as `type name-or-id`. */
export function targetLabel(target: AuditTarget): string {
  return `${target.type} ${target.name || target.id}`;
}

/** Targets summary for a table cell: the first target plus `+N` more. */
export function targetsSummary(targets: AuditTarget[] | undefined | null): string {
  if (!Array.isArray(targets) || targets.length === 0) return "—";
  const [first, ...rest] = targets;
  return rest.length > 0 ? `${targetLabel(first!)} +${rest.length}` : targetLabel(first!);
}

/** True for the `{ $erased: true }` marker that replaces an erased section. */
export function isErasedValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { $erased?: unknown }).$erased === true
  );
}

/** Sections erased after the fact (from the integrity block). */
export function erasedSections(event: Pick<AuditEvent, "integrity">): AuditSection[] {
  return event.integrity?.erased ?? [];
}

/** Tailwind classes for an outcome badge (flags/webhooks badge tone conventions). */
export function outcomeTone(outcome: AuditEvent["outcome"]): string {
  switch (outcome) {
    case "success":
      return "border-success/30 bg-success/10 text-success";
    case "failure":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-secondary/60 text-muted-foreground";
  }
}

/* ─── Action catalog ───────────────────────────────────────────────────────── */

/**
 * Group the action catalog by `group`, ungrouped last. Groups sorted by name;
 * entries sorted by name within a group.
 */
export function groupActions(
  catalog: ActionDefinition[],
): { group: string; actions: ActionDefinition[] }[] {
  const grouped = new Map<string, ActionDefinition[]>();
  for (const action of [...catalog].sort((a, b) => a.name.localeCompare(b.name))) {
    const group = action.group ?? "";
    const list = grouped.get(group) ?? [];
    list.push(action);
    grouped.set(group, list);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([group, actions]) => ({ group: group || "Ungrouped", actions }));
}

/** Whether the panel may edit a catalog entry: only UI-sourced ones (code is the source of truth). */
export function isEditableAction(action: ActionDefinition): boolean {
  return action.source !== "code";
}

/* ─── Streams ──────────────────────────────────────────────────────────────── */

export type StreamHealth = "healthy" | "lagging" | "failing";

/** Health of one stream/tenant cursor: failing beats lagging beats healthy. */
export function streamHealth(row: { lag: number; failures: number }): StreamHealth {
  if (row.failures > 0) return "failing";
  if (row.lag > 0) return "lagging";
  return "healthy";
}

/** Worst health across every tenant of every stream (overview tile). */
export function overallStreamHealth(streams: StreamStatus[]): StreamHealth {
  let worst: StreamHealth = "healthy";
  for (const s of streams) {
    for (const t of s.tenants) {
      const h = streamHealth(t);
      if (h === "failing") return "failing";
      if (h === "lagging") worst = "lagging";
    }
  }
  return worst;
}

/** Tailwind classes for a stream-health badge. */
export function streamHealthTone(health: StreamHealth): string {
  switch (health) {
    case "healthy":
      return "border-success/30 bg-success/10 text-success";
    case "lagging":
      return "border-warning/30 bg-warning/10 text-warning";
    case "failing":
      return "border-destructive/30 bg-destructive/10 text-destructive";
  }
}

/* ─── Integrity ────────────────────────────────────────────────────────────── */

/** Human label for a verify report's anchor. */
export function anchorLabel(anchor: VerifyReport["anchor"]): string {
  switch (anchor) {
    case "genesis":
      return "Genesis (seq 1)";
    case "checkpoint":
      return "Signed checkpoint";
    case "unanchored":
      return "Unanchored";
    case "none":
      return "None (empty range)";
  }
}

export interface VerificationSummary {
  tone: "ok" | "warn" | "fail";
  /** One line: "Verified through #42", "3 issues found", … */
  title: string;
  /** Secondary line (signing key, unsigned tail, …). */
  detail: string;
  /** Key id of the checkpoint that signs `signedThrough`, when known. */
  keyId?: string;
}

/**
 * Condense a {@link VerifyReport} (plus the tenant's checkpoints, to name the
 * signing key) into the portal badge copy: "Verified through #N, signed by key K".
 */
export function verificationSummary(
  report: VerifyReport,
  checkpoints: AuditCheckpoint[] = [],
): VerificationSummary {
  if (!report.ok) {
    const n = report.issues.length;
    return {
      tone: "fail",
      title: `Verification failed: ${n} issue${n === 1 ? "" : "s"} found`,
      detail: report.issues[0]?.message ?? "The log does not match its hash chain.",
    };
  }
  if (report.checked === 0 || report.toSeq === null) {
    return { tone: "ok", title: "No events to verify", detail: "The log is empty." };
  }
  if (report.signedThrough === null) {
    return {
      tone: "warn",
      title: `Chain intact through #${report.toSeq}`,
      detail: "Not yet anchored by a signed checkpoint.",
    };
  }
  const signer = [...checkpoints]
    .filter((c) => c.seq === report.signedThrough)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const keyId = signer?.keyId;
  const parts = [keyId ? `Signed by key ${keyId}` : "Signed checkpoint verified"];
  if (report.toSeq > report.signedThrough) {
    parts.push(`#${report.signedThrough + 1}–#${report.toSeq} intact, not yet signed`);
  }
  return {
    tone: "ok",
    title: `Verified through #${report.signedThrough}`,
    detail: parts.join(" · "),
    ...(keyId ? { keyId } : {}),
  };
}

/* ─── Export ───────────────────────────────────────────────────────────────── */

const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  csv: "csv",
  json: "json",
  jsonl: "jsonl",
  bundle: "bundle.json",
};

/**
 * Download filename for an export: the server's `content-disposition`
 * filename when present, else `audit-<tenant>.<ext>`.
 */
export function exportFileName(
  tenant: string,
  format: ExportFormat,
  contentDisposition?: string | null,
): string {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  const safe = tenant.replace(/[^a-zA-Z0-9._-]+/g, "_") || "tenant";
  return `audit-${safe}.${EXPORT_EXTENSIONS[format]}`;
}
