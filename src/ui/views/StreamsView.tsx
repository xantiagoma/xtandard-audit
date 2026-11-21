import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { AuditApiError } from "../types.ts";
import type { ShellContext } from "../App.tsx";
import { listStreams, retryStream } from "../api.ts";
import { useToast } from "@xtandard/kit/ui";
import { Button } from "@xtandard/kit/ui";
import {
  EmptyCard,
  LoadingRow,
  Mono,
  Page,
  PageHeader,
  StreamHealthBadge,
} from "../components/audit-bits.tsx";
import {
  formatCount,
  formatDateTime,
  overallStreamHealth,
  relativeTime,
  streamHealth,
  truncate,
} from "../lib/format.ts";

/**
 * Stream status: one card per stream, one row per tenant cursor — lag behind
 * the chain head, consecutive failures, the last error, and a Retry that
 * clears the backoff so the runner tries again on its next tick.
 */
export function StreamsView({ ctx }: { ctx: ShellContext }) {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["streams"], queryFn: listStreams, refetchInterval: 5_000 });
  const canRetry = !ctx.readonly && ctx.can("stream:retry");

  const retry = useMutation({
    mutationFn: ({ name, tenant }: { name: string; tenant?: string }) => retryStream(name, tenant),
    onSuccess: (_v, { name, tenant }) => {
      qc.invalidateQueries({ queryKey: ["streams"] });
      toast.add("success", "Retry scheduled", tenant ? `${name} · ${tenant}` : name);
    },
    onError: (err: unknown) =>
      toast.add("error", err instanceof AuditApiError ? err.body.error : "Retry failed"),
  });

  // With a tenant selected in the shell, show only its cursors.
  const streams = (query.data ?? []).map((s) => ({
    ...s,
    tenants: ctx.tenant ? s.tenants.filter((t) => t.tenant === ctx.tenant) : s.tenants,
  }));

  return (
    <Page>
      <PageHeader
        title="Streams"
        description="Sinks pull from each tenant's chain with their own cursor; a failing sink backs off without blocking the others."
      />
      {query.isLoading ? (
        <LoadingRow label="Loading streams…" />
      ) : query.isError ? (
        <EmptyCard>Failed to load streams.</EmptyCard>
      ) : streams.length === 0 ? (
        <EmptyCard>No streams configured.</EmptyCard>
      ) : (
        <div className="mt-6 flex flex-col gap-5">
          {streams.map((s) => (
            <section
              key={s.name}
              aria-label={`Stream ${s.name}`}
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                <StreamHealthBadge health={overallStreamHealth([s])} />
                <div className="min-w-0 flex-1">
                  <Mono className="text-[13px] font-semibold">{s.name}</Mono>
                  <span className="ml-2 text-xs text-muted-foreground">{s.kind}</span>
                </div>
                {canRetry && s.tenants.some((t) => t.failures > 0) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<RotateCcw className="size-3.5" />}
                    onClick={() => retry.mutate({ name: s.name })}
                  >
                    Retry all
                  </Button>
                )}
              </div>
              {s.tenants.length === 0 ? (
                <p className="m-0 px-4 py-4 text-[13px] text-muted-foreground">
                  No tenant cursors yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        {[
                          "Tenant",
                          "Status",
                          "Cursor",
                          "Lag",
                          "Failures",
                          "Last error",
                          "Delivered",
                          "",
                        ].map((h, i) => (
                          <th
                            key={h || i}
                            className="whitespace-nowrap px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {s.tenants.map((t) => (
                        <tr key={t.tenant}>
                          <td className="px-4 py-2.5">
                            <Mono>{t.tenant}</Mono>
                          </td>
                          <td className="px-4 py-2.5">
                            <StreamHealthBadge health={streamHealth(t)} />
                          </td>
                          <td className="px-4 py-2.5 text-[13px] tabular-nums">
                            #{t.cursor}
                            <span className="text-muted-foreground"> / #{t.headSeq}</span>
                          </td>
                          <td className="px-4 py-2.5 text-[13px] tabular-nums">
                            {formatCount(t.lag)}
                          </td>
                          <td className="px-4 py-2.5 text-[13px] tabular-nums">
                            {t.failures > 0 ? (
                              <span className="text-destructive">{t.failures}</span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                            {t.nextAttemptAt ? (
                              <span className="block text-xs text-muted-foreground">
                                next {relativeTime(t.nextAttemptAt)}
                              </span>
                            ) : null}
                          </td>
                          <td className="max-w-[260px] px-4 py-2.5 text-xs text-muted-foreground">
                            {t.lastError ? (
                              <span title={`${t.lastError}\n${formatDateTime(t.lastErrorAt)}`}>
                                <span className="block truncate text-destructive">
                                  {truncate(t.lastError, 120)}
                                </span>
                                {relativeTime(t.lastErrorAt)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td
                            className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted-foreground"
                            title={formatDateTime(t.lastDeliveredAt)}
                          >
                            {relativeTime(t.lastDeliveredAt)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {canRetry && t.failures > 0 && (
                              <Button
                                size="sm"
                                variant="secondary"
                                icon={<RotateCcw className="size-3.5" />}
                                loading={
                                  retry.isPending &&
                                  retry.variables?.name === s.name &&
                                  retry.variables?.tenant === t.tenant
                                }
                                onClick={() => retry.mutate({ name: s.name, tenant: t.tenant })}
                                aria-label={`Retry ${s.name} for ${t.tenant}`}
                              >
                                Retry
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
