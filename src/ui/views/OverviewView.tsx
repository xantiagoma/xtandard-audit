import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { ShellContext } from "../App.tsx";
import { getOverview } from "../api.ts";
import {
  EmptyCard,
  LoadingRow,
  Mono,
  OutcomeBadge,
  Page,
  PageHeader,
  StatCard,
  StreamHealthBadge,
} from "../components/audit-bits.tsx";
import {
  actorLabel,
  formatCount,
  formatDateTime,
  overallStreamHealth,
  relativeTime,
  streamHealth,
} from "../lib/format.ts";

const HEALTH_TONE = {
  healthy: "text-success",
  lagging: "text-warning",
  failing: "text-destructive",
} as const;

/**
 * Operator landing page: tenant and event totals, the latest events across
 * tenants, and stream health — all from one `GET /api/overview`.
 */
export function OverviewView({ ctx }: { ctx: ShellContext }) {
  const query = useQuery({
    queryKey: ["overview"],
    queryFn: getOverview,
    refetchInterval: 15_000,
  });

  const streamsEnabled = ctx.config.features?.streams !== false && ctx.can("stream:read");

  if (query.isLoading) {
    return (
      <Page>
        <PageHeader title="Overview" />
        <LoadingRow label="Loading overview…" />
      </Page>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Page>
        <PageHeader title="Overview" />
        <EmptyCard>Failed to load the overview.</EmptyCard>
      </Page>
    );
  }

  const { tenants, events, recent, streams } = query.data;
  const health = overallStreamHealth(streams);
  const cursors = streams.reduce((n, s) => n + s.tenants.length, 0);
  const totalLag = streams.reduce((n, s) => n + s.tenants.reduce((m, t) => m + t.lag, 0), 0);

  return (
    <Page>
      <PageHeader title="Overview" description="Every tenant's tamper-evident log at a glance." />

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Tenants" value={formatCount(tenants)} hint="Organizations with a log" />
        <StatCard
          label="Events"
          value={formatCount(events)}
          hint="Retained across all tenants"
          tone="text-chart-1"
        />
        {streamsEnabled ? (
          <StatCard
            label="Streams"
            value={streams.length === 0 ? "—" : health}
            hint={
              streams.length === 0
                ? "No streams configured"
                : `${streams.length} stream${streams.length === 1 ? "" : "s"} · ${cursors} cursor${cursors === 1 ? "" : "s"} · ${formatCount(totalLag)} behind`
            }
            tone={streams.length === 0 ? undefined : HEALTH_TONE[health]}
          />
        ) : (
          <StatCard label="Streams" value="—" hint="Streaming is not enabled" />
        )}
      </div>

      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Recent events</h2>
          <button
            onClick={() => ctx.go("/events")}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            View all
          </button>
        </div>
        {recent.length === 0 ? (
          <EmptyCard>No events recorded yet.</EmptyCard>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
            <ul className="divide-y divide-border">
              {recent.map((e) => (
                <li key={`${e.tenant}/${e.id}`}>
                  <button
                    onClick={() => ctx.go("/events", { event: e.id, eventTenant: e.tenant })}
                    className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/30"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px] font-medium text-foreground">
                        {e.action}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {actorLabel(e.actor)} · <span className="font-mono">{e.tenant}</span>
                      </span>
                    </div>
                    <OutcomeBadge outcome={e.outcome} />
                    <span
                      className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                      title={formatDateTime(e.occurredAt)}
                    >
                      {relativeTime(e.occurredAt)}
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {streamsEnabled && streams.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Stream health</h2>
            <button
              onClick={() => ctx.go("/streams")}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Details
            </button>
          </div>
          <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
            <ul className="divide-y divide-border">
              {streams.map((s) => {
                const worst = overallStreamHealth([s]);
                const lag = s.tenants.reduce((n, t) => n + t.lag, 0);
                const failing = s.tenants.filter((t) => streamHealth(t) === "failing").length;
                return (
                  <li key={s.name} className="flex items-center gap-3 px-4 py-3">
                    <StreamHealthBadge health={worst} />
                    <div className="min-w-0 flex-1">
                      <Mono className="block truncate font-medium">{s.name}</Mono>
                      <span className="text-xs text-muted-foreground">
                        {s.kind} · {s.tenants.length} tenant{s.tenants.length === 1 ? "" : "s"}
                        {failing > 0 ? ` · ${failing} failing` : ""}
                      </span>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatCount(lag)} behind
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Page>
  );
}
