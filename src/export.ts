/**
 * Exports: CSV, JSON and JSONL streams of a query, plus the **verifiable
 * bundle** — a JSONL file carrying a tenant's contiguous events together with
 * the checkpoints and public keys needed to verify it offline (ADR 0004).
 *
 * Every export is noted through `core.noteExport` (the `events.export` before
 * hook can deny it; the export is self-audited into the tenant's log).
 *
 * @module
 */

import type { ActorOptions, AuditCore } from "./core.ts";
import {
  verifyChain,
  keysFromJwks,
  type AuditVerificationKey,
  type VerifyReport,
} from "./integrity.ts";
import type { AuditCheckpoint, AuditEvent, AuditQuery } from "./schema.ts";
import type { ActionMap } from "./standard-schema.ts";

/** Export formats. */
export type ExportFormat = "csv" | "json" | "jsonl" | "bundle";

/** The MIME type of each format. */
export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  bundle: "application/x-ndjson; charset=utf-8",
};

/** CSV columns, in order. */
export const CSV_COLUMNS = [
  "id",
  "tenant",
  "seq",
  "occurred_at",
  "recorded_at",
  "action",
  "outcome",
  "actor_id",
  "actor_type",
  "actor_name",
  "actor_email",
  "targets",
  "ip",
  "user_agent",
  "request_id",
  "description",
  "metadata",
  "hash",
] as const;

/** Quote a CSV cell (RFC 4180) and neutralize spreadsheet formulas. */
export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  let s = typeof value === "string" ? value : JSON.stringify(value);
  // CSV injection: a leading = + - @ (or tab/CR) is evaluated by spreadsheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One event as a CSV row. */
export function eventToCsvRow(e: AuditEvent): string {
  const ctx = e.context ?? {};
  return [
    e.id,
    e.tenant,
    e.seq,
    e.occurredAt,
    e.recordedAt,
    e.action,
    e.outcome,
    e.actor.id,
    e.actor.type ?? "user",
    e.actor.name,
    e.actor.email,
    e.targets.length ? e.targets : "",
    ctx.ip,
    ctx.userAgent,
    ctx.requestId,
    e.description,
    Object.keys(e.metadata ?? {}).length ? e.metadata : "",
    e.integrity.hash,
  ]
    .map(csvCell)
    .join(",");
}

/** The first line of a bundle. */
export interface BundleHeader {
  type: "header";
  format: "xtandard-audit-bundle";
  v: 1;
  tenant: string;
  exportedAt: string;
  fromSeq: number | null;
  toSeq: number | null;
  /** `prevHash` the first event must carry when it is not seq 1 (the prune base). */
  baseHash?: string;
}

/** A parsed bundle. */
export interface ParsedBundle {
  header: BundleHeader;
  events: AuditEvent[];
  checkpoints: AuditCheckpoint[];
  jwks: { keys: JsonWebKey[] } | null;
}

/** Options for {@link exportEvents}. */
export interface ExportOptions extends ActorOptions {
  format: ExportFormat;
  /** Max events exported. Default 100 000. */
  maxEvents?: number;
}

const encoder = new TextEncoder();

async function* queryPages(core: AuditCore<ActionMap>, query: AuditQuery, max: number) {
  let cursor = query.cursor;
  let sent = 0;
  for (;;) {
    const page = await core.query({ ...query, limit: 500, ...(cursor ? { cursor } : {}) });
    for (const e of page.items) {
      if (sent >= max) return;
      sent++;
      yield e;
    }
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return;
    cursor = page.pageInfo.endCursor;
  }
}

async function* bundleLines(core: AuditCore<ActionMap>, tenant: string, max: number) {
  const head = await core.head(tenant);
  const fromSeq = head.baseSeq ?? 1;
  const header: BundleHeader = {
    type: "header",
    format: "xtandard-audit-bundle",
    v: 1,
    tenant,
    exportedAt: new Date(core.options.now()).toISOString(),
    fromSeq: head.seq >= fromSeq ? fromSeq : null,
    toSeq: head.seq >= fromSeq ? Math.min(head.seq, fromSeq + max - 1) : null,
    ...(head.baseHash ? { baseHash: head.baseHash } : {}),
  };
  yield JSON.stringify(header);
  let after = fromSeq - 1;
  const last = header.toSeq ?? 0;
  while (after < last) {
    const page = await core.eventsBySeq(tenant, { afterSeq: after, limit: 500 });
    if (page.length === 0) break;
    for (const e of page) if (e.seq <= last) yield JSON.stringify({ type: "event", ...e });
    after = page[page.length - 1]!.seq;
  }
  for (const cp of await core.listCheckpoints(tenant)) {
    yield JSON.stringify({ type: "checkpoint", ...cp });
  }
  yield JSON.stringify({ type: "jwks", ...(await core.jwks()) });
}

/**
 * Stream a query (or, for `"bundle"`, a tenant's whole retained chain) in the
 * given format. Requires `query.tenant` for every format (exports are always
 * per tenant).
 *
 * @example
 * ```ts
 * import { exportEvents } from "@xtandard/audit";
 *
 * const stream = await exportEvents(audit, { tenant: "acme", from: "2026-01-01" }, { format: "csv" });
 * return new Response(stream, { headers: { "content-type": "text/csv" } });
 * ```
 */
export async function exportEvents<A extends ActionMap>(
  core: AuditCore<A>,
  query: AuditQuery,
  options: ExportOptions,
): Promise<ReadableStream<Uint8Array>> {
  const tenant = query.tenant;
  if (!tenant) throw new TypeError("exportEvents requires query.tenant");
  const anyCore = core as unknown as AuditCore<ActionMap>;
  const max = options.maxEvents ?? 100_000;
  await core.noteExport(
    tenant,
    query,
    options.format,
    options.actor !== undefined ? { actor: options.actor } : {},
  );

  async function* lines(): AsyncGenerator<string> {
    switch (options.format) {
      case "csv":
        yield CSV_COLUMNS.join(",") + "\n";
        for await (const e of queryPages(anyCore, query, max)) yield eventToCsvRow(e) + "\n";
        return;
      case "jsonl":
        for await (const e of queryPages(anyCore, query, max)) yield JSON.stringify(e) + "\n";
        return;
      case "json": {
        yield "[";
        let first = true;
        for await (const e of queryPages(anyCore, query, max)) {
          yield (first ? "\n" : ",\n") + JSON.stringify(e);
          first = false;
        }
        yield "\n]\n";
        return;
      }
      case "bundle":
        for await (const line of bundleLines(anyCore, tenant!, max)) yield line + "\n";
        return;
    }
  }

  const iterator = lines();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

/** Parse a bundle (JSONL text). Throws on a malformed bundle. */
export function parseBundle(text: string): ParsedBundle {
  let header: BundleHeader | null = null;
  const events: AuditEvent[] = [];
  const checkpoints: AuditCheckpoint[] = [];
  let jwks: ParsedBundle["jwks"] = null;
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let item: { type?: string } & Record<string, unknown>;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`bundle line ${i + 1} is not JSON`);
    }
    const { type, ...rest } = item;
    if (type === "header") header = item as unknown as BundleHeader;
    else if (type === "event") events.push(rest as unknown as AuditEvent);
    else if (type === "checkpoint") checkpoints.push(rest as unknown as AuditCheckpoint);
    else if (type === "jwks") jwks = rest as unknown as { keys: JsonWebKey[] };
  }
  if (!header || header.format !== "xtandard-audit-bundle") {
    throw new Error("not an xtandard-audit bundle (missing header line)");
  }
  return { header, events, checkpoints, jwks };
}

/**
 * Verify a bundle offline. Keys default to the bundle's own JWKS — pass
 * `keys` (from a JWKS you obtained independently, e.g. the vendor's published
 * keys) to not trust the file for them.
 */
export async function verifyBundle(
  text: string,
  options: { keys?: AuditVerificationKey[] } = {},
): Promise<VerifyReport & { bundle: BundleHeader }> {
  const bundle = parseBundle(text);
  const keys = options.keys ?? (bundle.jwks ? await keysFromJwks(bundle.jwks as never) : undefined);
  const report = await verifyChain(bundle.events, {
    checkpoints: bundle.checkpoints,
    ...(keys && keys.length ? { keys } : {}),
  });
  const first = bundle.events.slice().sort((a, b) => a.seq - b.seq)[0];
  if (
    first &&
    first.seq > 1 &&
    bundle.header.baseHash &&
    first.integrity.prevHash !== bundle.header.baseHash
  ) {
    report.issues.push({
      kind: "link-mismatch",
      seq: first.seq,
      eventId: first.id,
      message: "first event does not link to the bundle's base hash",
    });
    report.ok = false;
  }
  if (bundle.header.toSeq !== null && report.toSeq !== bundle.header.toSeq) {
    report.issues.push({
      kind: "seq-gap",
      seq: (report.toSeq ?? 0) + 1,
      message: `bundle declares events through seq ${bundle.header.toSeq} but ends at ${report.toSeq}`,
    });
    report.ok = false;
  }
  return { ...report, bundle: bundle.header };
}
