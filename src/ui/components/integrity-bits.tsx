import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { AuditCheckpoint, VerifyReport } from "../types.ts";
import { AuditApiError } from "../types.ts";
import { listCheckpoints, verifyTenant } from "../api.ts";
import { anchorLabel, shortHash, verificationSummary } from "../lib/format.ts";
import { cn } from "@xtandard/kit/ui";
import { Button } from "@xtandard/kit/ui";
import { KeyValue, Mono, ToneBadge } from "./audit-bits.tsx";

const TONE_ICON = { ok: ShieldCheck, warn: ShieldQuestion, fail: ShieldAlert } as const;
const TONE_TEXT = { ok: "text-success", warn: "text-warning", fail: "text-destructive" } as const;

/** The one-line verdict ("Verified through #N, signed by key K") with its icon. */
export function VerifySummaryLine({
  report,
  checkpoints,
}: {
  report: VerifyReport;
  checkpoints?: AuditCheckpoint[];
}) {
  const summary = verificationSummary(report, checkpoints);
  const Icon = TONE_ICON[summary.tone];
  return (
    <div className="flex items-start gap-2.5" data-testid="verify-summary">
      <Icon className={cn("mt-0.5 size-5 shrink-0", TONE_TEXT[summary.tone])} aria-hidden />
      <div className="min-w-0">
        <p className={cn("m-0 text-[14px] font-semibold", TONE_TEXT[summary.tone])}>
          {summary.title}
        </p>
        <p className="m-0 mt-0.5 text-xs text-muted-foreground">{summary.detail}</p>
      </div>
    </div>
  );
}

/** A full {@link VerifyReport}: verdict, coverage, issues, erasures. */
export function VerifyReportView({
  report,
  checkpoints,
}: {
  report: VerifyReport;
  checkpoints?: AuditCheckpoint[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <VerifySummaryLine report={report} checkpoints={checkpoints} />

      <dl className="m-0 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <KeyValue label="Result">
          {report.ok ? (
            <ToneBadge tone="success">ok</ToneBadge>
          ) : (
            <ToneBadge tone="destructive">failed</ToneBadge>
          )}
        </KeyValue>
        <KeyValue label="Events checked">
          <span className="tabular-nums">{report.checked}</span>
          {report.fromSeq !== null && report.toSeq !== null ? (
            <span className="text-muted-foreground">
              {" "}
              (#{report.fromSeq}–#{report.toSeq})
            </span>
          ) : null}
        </KeyValue>
        <KeyValue label="Anchor">{anchorLabel(report.anchor)}</KeyValue>
        <KeyValue label="Signed through">
          {report.signedThrough === null ? (
            <span className="text-muted-foreground">not signed yet</span>
          ) : (
            <span className="tabular-nums">#{report.signedThrough}</span>
          )}
        </KeyValue>
        <KeyValue label="Checkpoints">
          <span className="tabular-nums">{report.checkpointsVerified}</span> verified
        </KeyValue>
        <KeyValue label="Links checked">{report.linksChecked ? "yes" : "no (subset)"}</KeyValue>
        <KeyValue label="Head hash" copy={report.headHash ?? undefined}>
          <Mono>{shortHash(report.headHash, 16)}</Mono>
        </KeyValue>
      </dl>

      {report.issues.length > 0 && (
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Issues
          </h3>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-destructive/30">
            {report.issues.map((issue, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 px-3 py-2 text-[13px]">
                <ToneBadge tone="destructive">{issue.kind}</ToneBadge>
                {issue.seq !== undefined && (
                  <Mono className="text-muted-foreground">#{issue.seq}</Mono>
                )}
                {issue.section && <Mono className="text-muted-foreground">{issue.section}</Mono>}
                <span className="min-w-0 flex-1 text-foreground">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.erased.length > 0 && (
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Erased sections
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Content removed after the fact; the digests are kept, so the chain still verifies.
          </p>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {report.erased.map((e) => (
              <li key={e.eventId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Mono className="text-muted-foreground">#{e.seq}</Mono>
                <Mono className="min-w-0 flex-1 truncate">{e.eventId}</Mono>
                {e.sections.map((s) => (
                  <ToneBadge key={s} tone="warning">
                    {s}
                  </ToneBadge>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The portal's "Verify log integrity" panel: one button that runs the server
 * verifier over the tenant's chain and condenses the report to a badge line.
 */
export function VerifyPanel({ tenant }: { tenant: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const verify = useMutation({ mutationFn: () => verifyTenant(tenant) });
  const checkpoints = useQuery({
    queryKey: ["checkpoints", tenant],
    queryFn: () => listCheckpoints(tenant),
    enabled: verify.isSuccess,
    staleTime: 30_000,
  });

  return (
    <section
      aria-label="Log integrity"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          {verify.data ? (
            <VerifySummaryLine report={verify.data} checkpoints={checkpoints.data} />
          ) : verify.isError ? (
            <p className="m-0 text-[13px] text-destructive">
              {verify.error instanceof AuditApiError
                ? verify.error.body.error
                : "Verification could not run."}
            </p>
          ) : (
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <p className="m-0 text-[13px] font-semibold text-foreground">Tamper-evident log</p>
                <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                  Every event is hash-chained to the one before it and periodically signed. Check
                  that nothing was altered or removed.
                </p>
              </div>
            </div>
          )}
        </div>
        {verify.data && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide details" : "Details"}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          loading={verify.isPending}
          icon={<ShieldCheck className="size-3.5" />}
          onClick={() => verify.mutate()}
          disabled={!tenant}
        >
          {verify.data ? "Verify again" : "Verify log integrity"}
        </Button>
      </div>
      {expanded && verify.data && (
        <div className="border-t border-border pt-3">
          <VerifyReportView report={verify.data} checkpoints={checkpoints.data} />
        </div>
      )}
    </section>
  );
}
