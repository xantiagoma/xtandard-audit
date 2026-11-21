import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, PenLine, ShieldCheck } from "lucide-react";
import { AuditApiError } from "../types.ts";
import type { ShellContext } from "../App.tsx";
import {
  createCheckpoint,
  getTenant,
  jwksUrl,
  listCheckpoints,
  listTenants,
  verifyTenant,
} from "../api.ts";
import { useToast } from "../components/Toast.tsx";
import { Button } from "../components/ui-bits.tsx";
import { VerifyReportView } from "../components/integrity-bits.tsx";
import {
  CopyButton,
  EmptyCard,
  KeyValue,
  LoadingRow,
  Mono,
  Page,
  PageHeader,
  SectionCard,
  ToneBadge,
} from "../components/audit-bits.tsx";
import { formatCount, formatDateTime, relativeTime, shortHash } from "../lib/format.ts";

const errMessage = (err: unknown, fallback: string): string =>
  err instanceof AuditApiError ? err.body.error : fallback;

/** Admin with "All tenants" selected: pick the chain to inspect. */
function TenantPicker({ ctx }: { ctx: ShellContext }) {
  const query = useQuery({ queryKey: ["tenants"], queryFn: listTenants, staleTime: 30_000 });
  const tenants = query.data ?? [];
  if (query.isLoading) return <LoadingRow label="Loading tenants…" />;
  if (tenants.length === 0) return <EmptyCard>No tenants yet.</EmptyCard>;
  return (
    <div className="mt-6">
      <p className="text-[13px] text-muted-foreground">
        Each tenant has its own chain. Choose one to verify:
      </p>
      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
        <ul className="divide-y divide-border">
          {tenants.map((t) => (
            <li key={t.key}>
              <button
                onClick={() => ctx.setTenant(t.key)}
                className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/30"
              >
                <Mono className="min-w-0 flex-1 truncate font-medium">{t.key}</Mono>
                <span className="text-xs tabular-nums text-muted-foreground">
                  head #{t.head.seq}
                </span>
                <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Per-tenant integrity: the chain head, an on-demand server-side verification
 * (the same `verifyChain` an auditor runs on an export bundle), the signed
 * checkpoints, and the public JWKS that verifies them.
 */
export function IntegrityView({ ctx }: { ctx: ShellContext }) {
  const { tenant, portal } = ctx;
  const toast = useToast();
  const qc = useQueryClient();

  const headQuery = useQuery({
    queryKey: ["tenant", tenant],
    queryFn: () => getTenant(tenant),
    enabled: tenant !== "" && !portal && ctx.can("tenant:read"),
  });
  const checkpointsQuery = useQuery({
    queryKey: ["checkpoints", tenant],
    queryFn: () => listCheckpoints(tenant),
    enabled: tenant !== "",
  });
  const verify = useMutation({
    mutationKey: ["verify", tenant],
    mutationFn: () => verifyTenant(tenant),
    onError: (err: unknown) => toast.add("error", errMessage(err, "Verification failed to run")),
  });
  const checkpoint = useMutation({
    mutationFn: () => createCheckpoint(tenant),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["checkpoints", tenant] });
      toast.add("success", "Checkpoint created", `Signed #${c.seq} with key ${c.keyId}`);
    },
    onError: (err: unknown) => toast.add("error", errMessage(err, "Failed to create checkpoint")),
  });

  // A different tenant's report must not linger after switching.
  const { reset } = verify;
  React.useEffect(() => reset(), [tenant, reset]);

  const signer = ctx.config.features?.signer !== false;
  const canCheckpoint =
    !portal && !ctx.readonly && signer && ctx.can("integrity:checkpoint") && tenant !== "";
  const checkpoints = [...(checkpointsQuery.data ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const head = headQuery.data?.head;

  return (
    <Page>
      <PageHeader
        title="Integrity"
        description={
          tenant ? (
            <>
              Hash chain and signed checkpoints for <span className="font-mono">{tenant}</span>.
            </>
          ) : (
            "Every tenant's log is a hash chain, periodically signed."
          )
        }
        actions={
          <a
            href={jwksUrl()}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          >
            Public keys (JWKS) <ExternalLink className="size-3.5" />
          </a>
        }
      />

      {!tenant ? (
        portal ? (
          <EmptyCard>No tenant in scope.</EmptyCard>
        ) : (
          <TenantPicker ctx={ctx} />
        )
      ) : (
        <div className="mt-6 flex flex-col gap-5">
          {head && (
            <SectionCard title="Chain head">
              <dl className="m-0 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                <KeyValue label="Head seq">
                  <span className="tabular-nums">#{head.seq}</span>
                </KeyValue>
                <KeyValue label="Retained events">{formatCount(headQuery.data?.count)}</KeyValue>
                <KeyValue label="Head hash" copy={head.hash}>
                  <Mono>{shortHash(head.hash, 16)}</Mono>
                </KeyValue>
                <KeyValue label="Base seq">
                  <span className="tabular-nums">#{head.baseSeq ?? 1}</span>
                  {(head.baseSeq ?? 1) > 1 ? (
                    <span className="text-muted-foreground"> (older events pruned)</span>
                  ) : null}
                </KeyValue>
                <KeyValue label="Last append">
                  {head.updatedAt ? (
                    <span title={formatDateTime(head.updatedAt)}>
                      {relativeTime(head.updatedAt)}
                    </span>
                  ) : (
                    "—"
                  )}
                </KeyValue>
              </dl>
            </SectionCard>
          )}

          <SectionCard
            title="Verification"
            description="Recomputes every digest and hash, checks the links between events, and verifies checkpoint signatures."
            actions={
              <Button
                variant="primary"
                size="sm"
                icon={<ShieldCheck className="size-3.5" />}
                loading={verify.isPending}
                onClick={() => verify.mutate()}
              >
                {verify.data ? "Verify again" : "Verify chain"}
              </Button>
            }
          >
            {verify.data ? (
              <VerifyReportView report={verify.data} checkpoints={checkpointsQuery.data} />
            ) : (
              <p className="m-0 text-[13px] text-muted-foreground">
                Not verified in this session yet.
              </p>
            )}
          </SectionCard>

          <SectionCard
            title="Checkpoints"
            description={
              signer
                ? "Signed chain heads. Events up to a checkpoint cannot be altered without breaking its signature."
                : "No signer is configured, so checkpoints cannot be created."
            }
            actions={
              canCheckpoint ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<PenLine className="size-3.5" />}
                  loading={checkpoint.isPending}
                  onClick={() => checkpoint.mutate()}
                >
                  Create checkpoint
                </Button>
              ) : undefined
            }
          >
            {checkpointsQuery.isLoading ? (
              <LoadingRow label="Loading checkpoints…" />
            ) : checkpoints.length === 0 ? (
              <p className="m-0 text-[13px] text-muted-foreground">No checkpoints yet.</p>
            ) : (
              <div className="-mx-4 -my-4 overflow-x-auto">
                <table className="w-full border-collapse" aria-label="Checkpoints">
                  <thead>
                    <tr className="border-b border-border">
                      {["Seq", "Kind", "Hash", "Key", "Signed"].map((h) => (
                        <th
                          key={h}
                          className="whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {checkpoints.map((c) => (
                      <tr key={c.id}>
                        <td className="px-4 py-2.5 text-[13px] tabular-nums">#{c.seq}</td>
                        <td className="px-4 py-2.5">
                          <ToneBadge tone={c.kind === "base" ? "warning" : "accent"}>
                            {c.kind}
                          </ToneBadge>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1">
                            <Mono className="text-muted-foreground">{shortHash(c.hash, 10)}</Mono>
                            <CopyButton value={c.hash} label={`Copy checkpoint hash #${c.seq}`} />
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <Mono>{c.keyId}</Mono>{" "}
                          <span className="text-xs text-muted-foreground">{c.alg}</span>
                        </td>
                        <td
                          className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted-foreground"
                          title={formatDateTime(c.at)}
                        >
                          {relativeTime(c.at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </Page>
  );
}
