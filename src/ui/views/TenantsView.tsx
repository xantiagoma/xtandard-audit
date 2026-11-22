import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { AuditTenant } from "../types.ts";
import type { ShellContext } from "../App.tsx";
import { listCheckpoints, listTenants } from "../api.ts";
import { Button } from "@xtandard/kit/ui";
import { EmptyCard, LoadingRow, Mono, Page, PageHeader } from "../components/audit-bits.tsx";
import { formatCount, formatDateTime, relativeTime, shortHash } from "../lib/format.ts";

/** Latest checkpoint for one tenant (lazy per row; only with `integrity:read`). */
function LastCheckpoint({ tenant }: { tenant: string }) {
  const query = useQuery({
    queryKey: ["checkpoints", tenant],
    queryFn: () => listCheckpoints(tenant),
    staleTime: 30_000,
  });
  if (query.isLoading) return <span className="text-muted-foreground">…</span>;
  const latest = [...(query.data ?? [])].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!latest) return <span className="text-muted-foreground">none</span>;
  return (
    <span title={`${latest.kind} · ${latest.keyId} · ${formatDateTime(latest.at)}`}>
      <span className="tabular-nums">#{latest.seq}</span>{" "}
      <span className="text-muted-foreground">{relativeTime(latest.at)}</span>
    </span>
  );
}

function TenantRow({ t, ctx }: { t: AuditTenant; ctx: ShellContext }) {
  const base = t.head.baseSeq ?? 1;
  return (
    <tr>
      <td className="px-4 py-3">
        <Mono className="font-medium">{t.key}</Mono>
        {t.createdAt ? (
          <span className="block text-xs text-muted-foreground">
            since {formatDateTime(t.createdAt)}
          </span>
        ) : null}
      </td>
      <td className="px-4 py-3 text-right text-[13px] tabular-nums">{formatCount(t.count)}</td>
      <td className="px-4 py-3 text-[13px]">
        <span className="tabular-nums">#{t.head.seq}</span>{" "}
        <Mono className="text-muted-foreground">{shortHash(t.head.hash, 8)}</Mono>
        {t.head.updatedAt ? (
          <span className="block text-xs text-muted-foreground">
            {relativeTime(t.head.updatedAt)}
          </span>
        ) : null}
      </td>
      <td className="px-4 py-3 text-[13px] tabular-nums">
        {base > 1 ? `#${base}` : <span className="text-muted-foreground">#1</span>}
      </td>
      <td className="px-4 py-3 text-[13px]">
        {ctx.can("integrity:read") ? <LastCheckpoint tenant={t.key} /> : "—"}
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1.5">
          {ctx.can("event:read") && (
            <Button size="sm" variant="ghost" onClick={() => ctx.go("/events", { tenant: t.key })}>
              Events
            </Button>
          )}
          {ctx.can("integrity:read") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => ctx.go("/integrity", { tenant: t.key })}
            >
              Integrity
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Every tenant's chain: retained events, head, prune base, last checkpoint. */
export function TenantsView({ ctx }: { ctx: ShellContext }) {
  const query = useQuery({ queryKey: ["tenants"], queryFn: listTenants, staleTime: 10_000 });
  const tenants = query.data ?? [];

  return (
    <Page>
      <PageHeader
        title="Tenants"
        description="Each tenant (customer organization) has its own hash chain. Tenants appear on their first event."
      />
      {query.isLoading ? (
        <LoadingRow label="Loading tenants…" />
      ) : query.isError ? (
        <EmptyCard>Failed to load tenants.</EmptyCard>
      ) : tenants.length === 0 ? (
        <EmptyCard>No tenants yet. Record an event to create one.</EmptyCard>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  {["Tenant", "Events", "Head", "Base", "Last checkpoint", ""].map((h, i) => (
                    <th
                      key={h || i}
                      className={
                        "whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" +
                        (h === "Events" ? " text-right" : "")
                      }
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tenants.map((t) => (
                  <TenantRow key={t.key} t={t} ctx={ctx} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Page>
  );
}
