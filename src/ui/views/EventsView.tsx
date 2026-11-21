import React from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "wouter";
import { ChevronRight, RefreshCw, Search, X } from "lucide-react";
import type { AuditEvent } from "../types.ts";
import type { ShellContext } from "../App.tsx";
import { listActions, listEvents } from "../api.ts";
import { Button } from "@xtandard/kit/ui";
import { Dropdown, Segmented, TextInput } from "@xtandard/kit/ui";
import { ActionFilter } from "../components/ActionFilter.tsx";
import { ExportMenu } from "../components/ExportMenu.tsx";
import { VerifyPanel } from "../components/integrity-bits.tsx";
import {
  EmptyCard,
  LoadingRow,
  OutcomeBadge,
  Page,
  PageHeader,
} from "../components/audit-bits.tsx";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filtersFromSearch,
  filtersToSearch,
  isoToLocalInput,
  localInputToIso,
  TIME_RANGES,
  toApiQuery,
  type EventFilters,
  type TimeRange,
} from "../lib/filters.ts";
import { actorLabel, formatDateTime, relativeTime, targetsSummary } from "../lib/format.ts";
import { cn } from "@xtandard/kit/ui";
import { EventDrawer } from "./EventDrawer.tsx";

const PAGE_SIZE = 50;

/**
 * A text input that commits to the URL after a short idle (typing doesn't
 * spam history or the API), on Enter, and on blur. Re-syncs when the URL
 * changes underneath it (back/forward, "Clear filters").
 */
function FilterInput({
  value,
  onCommit,
  label,
  placeholder,
  icon,
  className,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  const [local, setLocal] = React.useState(value);
  const commitRef = React.useRef(onCommit);
  commitRef.current = onCommit;

  React.useEffect(() => setLocal(value), [value]);
  React.useEffect(() => {
    if (local === value) return;
    const t = setTimeout(() => commitRef.current(local), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);

  return (
    <div className={cn("relative", className)}>
      {icon ? (
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
          {icon}
        </span>
      ) : null}
      <TextInput
        aria-label={label}
        placeholder={placeholder}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => local !== value && onCommit(local)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && local !== value) onCommit(local);
        }}
        className={icon ? "pl-8" : undefined}
      />
    </div>
  );
}

function FilterBar({
  filters,
  onChange,
  actionNames,
}: {
  filters: EventFilters;
  onChange: (patch: Partial<EventFilters>) => void;
  actionNames: string[];
}) {
  const active = activeFilterCount(filters);
  return (
    <div className="mt-6 flex flex-col gap-2.5" role="search" aria-label="Event filters">
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterInput
          label="Search events"
          placeholder="Search actions, actors, targets, metadata…"
          value={filters.search}
          onCommit={(search) => onChange({ search })}
          icon={<Search className="size-3.5" />}
          className="min-w-[14rem] flex-1"
        />
        <Dropdown
          aria-label="Time range"
          value={filters.range}
          onValueChange={(range) => onChange({ range: range as TimeRange })}
          options={TIME_RANGES}
          className="w-44"
        />
        <Segmented
          value={filters.outcome || "all"}
          onValueChange={(v) => onChange({ outcome: v === "all" ? "" : v })}
          options={[
            { value: "all", label: "All" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failure" },
          ]}
        />
      </div>
      {filters.range === "custom" && (
        <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
          <label className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">From</span>
            <TextInput
              type="datetime-local"
              aria-label="From"
              value={isoToLocalInput(filters.from)}
              onChange={(e) => onChange({ from: localInputToIso(e.target.value) })}
              className="w-56"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">To</span>
            <TextInput
              type="datetime-local"
              aria-label="To"
              value={isoToLocalInput(filters.to)}
              onChange={(e) => onChange({ to: localInputToIso(e.target.value) })}
              className="w-56"
            />
          </label>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
        <ActionFilter
          value={filters.actions}
          onChange={(actions) => onChange({ actions })}
          names={actionNames}
        />
        <FilterInput
          label="Actor id"
          placeholder="Actor id"
          value={filters.actorId}
          onCommit={(actorId) => onChange({ actorId })}
        />
        <FilterInput
          label="Actor type"
          placeholder="Actor type"
          value={filters.actorType}
          onCommit={(actorType) => onChange({ actorType })}
        />
        <FilterInput
          label="Target type"
          placeholder="Target type"
          value={filters.targetType}
          onCommit={(targetType) => onChange({ targetType })}
        />
        <FilterInput
          label="Target id"
          placeholder="Target id"
          value={filters.targetId}
          onCommit={(targetId) => onChange({ targetId })}
        />
      </div>
      {active > 0 && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon={<X className="size-3.5" />}
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            Clear filters ({active})
          </Button>
        </div>
      )}
    </div>
  );
}

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 md:grid-cols-[7rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem]";

function EventRow({
  event,
  showTenant,
  onOpen,
}: {
  event: AuditEvent;
  showTenant: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        className={cn(
          ROW_GRID,
          "group w-full px-4 py-2.5 text-left transition-colors hover:bg-secondary/30",
        )}
        data-testid="event-row"
      >
        <span
          className="order-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground md:order-none"
          title={formatDateTime(event.occurredAt)}
        >
          {relativeTime(event.occurredAt)}
        </span>
        <span className="order-1 min-w-0 md:order-none">
          <span className="block truncate font-mono text-[13px] font-medium text-foreground">
            {event.action}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            <span className="font-mono">#{event.seq}</span>
            {showTenant ? (
              <>
                {" · "}
                <span className="font-mono">{event.tenant}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="order-3 min-w-0 truncate text-[13px] text-foreground md:order-none">
          {actorLabel(event.actor)}
          {event.actor?.type && event.actor.type !== "user" ? (
            <span className="ml-1 text-xs text-muted-foreground">({event.actor.type})</span>
          ) : null}
        </span>
        <span className="order-4 hidden min-w-0 truncate text-[13px] text-muted-foreground md:order-none md:block">
          {targetsSummary(event.targets)}
        </span>
        <span className="order-5 hidden items-center justify-end gap-1 md:order-none md:flex">
          <OutcomeBadge outcome={event.outcome} />
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
        </span>
      </button>
    </li>
  );
}

/**
 * The Events explorer — the core screen. Filters live in the URL; the list is
 * keyset-paginated (auto-loads as you scroll, with a "Load more" fallback); a
 * row opens the detail drawer (`?event=…&eventTenant=…`, deep-linkable).
 */
export function EventsView({ ctx }: { ctx: ShellContext }) {
  const { tenant, portal } = ctx;
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = React.useMemo(() => filtersFromSearch(searchParams), [searchParams]);
  const filtersKey = filtersToSearch(filters).toString();
  // Relative presets resolve once per filter change (and on Refresh), so every
  // page of one listing runs the same query.
  const [refreshTick, setRefreshTick] = React.useState(0);
  const apiQuery = React.useMemo(
    () => toApiQuery(filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtersKey, refreshTick],
  );

  const setFilters = (patch: Partial<EventFilters>) => {
    setSearchParams(
      (prev) => filtersToSearch({ ...filters, ...patch }, new URLSearchParams(prev)),
      {
        replace: true,
      },
    );
  };

  const catalogQuery = useQuery({
    queryKey: ["actions"],
    queryFn: listActions,
    staleTime: 60_000,
    enabled: ctx.can("action:read"),
  });

  const query = useInfiniteQuery({
    queryKey: ["events", tenant, apiQuery],
    queryFn: ({ pageParam }) =>
      listEvents(tenant || undefined, apiQuery, {
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: "",
    // Keep the current rows on screen while a new filter loads (no flash to a
    // spinner, and a click right after typing still lands on a row).
    placeholderData: keepPreviousData,
    getNextPageParam: (last) =>
      last.pageInfo.hasNextPage ? (last.pageInfo.endCursor ?? undefined) : undefined,
  });
  const events = React.useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  // Autocomplete: the catalog, plus actions seen on screen (hosts that never
  // define a catalog still get suggestions).
  const actionNames = React.useMemo(() => {
    const names = new Set((catalogQuery.data ?? []).map((a) => a.name));
    for (const e of events) names.add(e.action);
    return [...names];
  }, [catalogQuery.data, events]);

  // Infinite scroll: fetch the next page when the sentinel scrolls into view.
  const sentinel = React.useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const openId = searchParams.get("event");
  const openTenant = searchParams.get("eventTenant") || tenant;
  const openEvent = (e: AuditEvent) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("event", e.id);
      next.set("eventTenant", e.tenant);
      return next;
    });
  const closeEvent = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("event");
        next.delete("eventTenant");
        return next;
      },
      { replace: true },
    );

  const filtered = activeFilterCount(filters) > 0;
  const exportQuery = React.useMemo(() => ({ ...apiQuery }), [apiQuery]);

  return (
    <Page>
      <PageHeader
        title="Events"
        description={
          portal ? (
            "Everything that happened in your organization, newest first."
          ) : tenant ? (
            <>
              The audit log of <span className="font-mono">{tenant}</span>, newest first.
            </>
          ) : (
            "Every tenant's audit log, newest first."
          )
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => setRefreshTick((t) => t + 1)}
            >
              <RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} />
            </Button>
            {ctx.can("event:export") && (
              <ExportMenu
                tenant={tenant}
                query={exportQuery}
                disabledReason={tenant ? undefined : "Select a tenant to export its log"}
              />
            )}
          </div>
        }
      />

      {portal && tenant && ctx.can("integrity:read") && (
        <div className="mt-6">
          <VerifyPanel tenant={tenant} />
        </div>
      )}

      <FilterBar filters={filters} onChange={setFilters} actionNames={actionNames} />

      {query.isLoading ? (
        <LoadingRow label="Loading events…" />
      ) : query.isError ? (
        <EmptyCard>Failed to load events.</EmptyCard>
      ) : events.length === 0 ? (
        <EmptyCard>
          {filtered ? "No events match these filters." : "No events recorded yet."}
        </EmptyCard>
      ) : (
        <>
          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
            <div
              className={cn(
                ROW_GRID,
                "hidden border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:grid",
              )}
              aria-hidden
            >
              <span>When</span>
              <span>Action</span>
              <span>Actor</span>
              <span>Target</span>
              <span className="pr-5 text-right">Outcome</span>
            </div>
            <ul className="divide-y divide-border" aria-label="Events">
              {events.map((event) => (
                <EventRow
                  key={`${event.tenant}/${event.id}`}
                  event={event}
                  showTenant={!tenant}
                  onOpen={() => openEvent(event)}
                />
              ))}
            </ul>
          </div>
          <div ref={sentinel} className="mt-4 flex items-center justify-center gap-3">
            <span className="text-xs text-muted-foreground">
              {events.length} event{events.length === 1 ? "" : "s"}
              {hasNextPage ? " loaded" : ""}
            </span>
            {hasNextPage && (
              <Button
                variant="secondary"
                size="sm"
                loading={isFetchingNextPage}
                onClick={() => fetchNextPage()}
              >
                Load more
              </Button>
            )}
          </div>
        </>
      )}

      {openId && openTenant && (
        <EventDrawer
          key={`${openTenant}/${openId}`}
          tenant={openTenant}
          id={openId}
          initial={events.find((e) => e.id === openId && e.tenant === openTenant)}
          canErase={!portal && !ctx.readonly && ctx.can("event:erase")}
          onClose={closeEvent}
        />
      )}
    </Page>
  );
}
