/**
 * The Events explorer's filter model and its URL encoding — pure, no React,
 * no DOM. Filters live in the URL query string so a filtered view is a
 * shareable, reload-safe link; {@link toApiQuery} turns them into the HTTP
 * API's query parameters (docs/HTTP_API.md). Unit-tested in
 * `test/ui-lib.test.ts`.
 *
 * @module
 */

import type { AuditOutcome } from "../types.ts";

/** Time-range presets offered by the filter bar. `custom` uses `from`/`to`. */
export type TimeRange = "all" | "15m" | "1h" | "24h" | "7d" | "30d" | "custom";

export const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
];

const RANGE_MS: Record<Exclude<TimeRange, "all" | "custom">, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** The explorer's filter state (tenant is separate: it is shell-level context). */
export interface EventFilters {
  /** Exact names or families (`invoice.*`). */
  actions: string[];
  actorId: string;
  actorType: string;
  targetType: string;
  targetId: string;
  outcome: "" | AuditOutcome;
  range: TimeRange;
  /** ISO-8601, `custom` range only (inclusive). */
  from: string;
  /** ISO-8601, `custom` range only (exclusive). */
  to: string;
  search: string;
}

export const EMPTY_FILTERS: EventFilters = {
  actions: [],
  actorId: "",
  actorType: "",
  targetType: "",
  targetId: "",
  outcome: "",
  range: "all",
  from: "",
  to: "",
  search: "",
};

// URL parameter names. Short where the UI owns the name (`q`, `actor`); the
// API's own names otherwise, so a URL reads like the query it runs.
const PARAM = {
  actions: "actions",
  actorId: "actor",
  actorType: "actorType",
  targetType: "targetType",
  targetId: "targetId",
  outcome: "outcome",
  range: "range",
  from: "from",
  to: "to",
  search: "q",
} as const satisfies Record<keyof EventFilters, string>;

/** Every URL parameter the filter model owns (other params — `tenant`, `event` — pass through). */
export const FILTER_PARAMS: readonly string[] = Object.values(PARAM);

const isRange = (v: string | null): v is TimeRange => TIME_RANGES.some((r) => r.value === v);

/** Split a list parameter (repeated and/or comma-separated), trimmed, de-duplicated. */
export function parseList(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const part of v.split(",")) {
      const s = part.trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Read the filters from a URL query string. Unknown/invalid values fall back to empty. */
export function filtersFromSearch(search: URLSearchParams): EventFilters {
  const get = (key: string) => search.get(key) ?? "";
  const outcome = get(PARAM.outcome);
  const range = search.get(PARAM.range);
  const from = get(PARAM.from);
  const to = get(PARAM.to);
  return {
    actions: parseList(search.getAll(PARAM.actions)),
    actorId: get(PARAM.actorId),
    actorType: get(PARAM.actorType),
    targetType: get(PARAM.targetType),
    targetId: get(PARAM.targetId),
    outcome: outcome === "success" || outcome === "failure" ? outcome : "",
    // A bare from/to (hand-written link) implies a custom range.
    range: isRange(range) ? range : from || to ? "custom" : "all",
    from,
    to,
    search: get(PARAM.search),
  };
}

/**
 * Write `filters` into a copy of `base` (other params are preserved; filter
 * params at their default are removed so URLs stay short).
 */
export function filtersToSearch(
  filters: EventFilters,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const key of FILTER_PARAMS) next.delete(key);
  if (filters.actions.length > 0) next.set(PARAM.actions, filters.actions.join(","));
  const scalars: (keyof Omit<EventFilters, "actions" | "range" | "from" | "to">)[] = [
    "actorId",
    "actorType",
    "targetType",
    "targetId",
    "outcome",
    "search",
  ];
  for (const key of scalars) {
    const value = filters[key].trim();
    if (value) next.set(PARAM[key], value);
  }
  if (filters.range !== "all") next.set(PARAM.range, filters.range);
  if (filters.range === "custom") {
    if (filters.from) next.set(PARAM.from, filters.from);
    if (filters.to) next.set(PARAM.to, filters.to);
  }
  return next;
}

/** Number of active filters (the "Clear filters" badge). */
export function activeFilterCount(filters: EventFilters): number {
  let n = filters.actions.length > 0 ? 1 : 0;
  for (const key of [
    "actorId",
    "actorType",
    "targetType",
    "targetId",
    "outcome",
    "search",
  ] as const) {
    if (filters[key].trim()) n++;
  }
  if (filters.range !== "all" && (filters.range !== "custom" || filters.from || filters.to)) n++;
  return n;
}

/**
 * The HTTP API query for `filters` (docs/HTTP_API.md "Query parameters").
 * Relative presets resolve against `now`, so callers compute this once per
 * filter change and keep it stable across pages (keyset cursors assume the
 * same query).
 */
export function toApiQuery(
  filters: EventFilters,
  now: number = Date.now(),
): Record<string, string> {
  const q: Record<string, string> = {};
  if (filters.actions.length > 0) q.actions = filters.actions.join(",");
  if (filters.actorId.trim()) q.actorId = filters.actorId.trim();
  if (filters.actorType.trim()) q.actorType = filters.actorType.trim();
  if (filters.targetType.trim()) q.targetType = filters.targetType.trim();
  if (filters.targetId.trim()) q.targetId = filters.targetId.trim();
  if (filters.outcome) q.outcome = filters.outcome;
  if (filters.search.trim()) q.search = filters.search.trim();
  if (filters.range === "custom") {
    if (filters.from) q.from = filters.from;
    if (filters.to) q.to = filters.to;
  } else if (filters.range !== "all") {
    q.from = new Date(now - RANGE_MS[filters.range]).toISOString();
  }
  return q;
}

/* ─── datetime-local ⇄ ISO ─────────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO-8601 → the local-time `YYYY-MM-DDTHH:mm` an `<input type="datetime-local">` takes. */
export function isoToLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value (local time) → ISO-8601 UTC; `""` for empty/invalid. */
export function localInputToIso(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/* ─── Action autocomplete ──────────────────────────────────────────────────── */

/** `invoice.*`-style family pattern. */
export function isFamily(pattern: string): boolean {
  return pattern.endsWith("*");
}

/**
 * Every family (`a.*`, `a.b.*`) implied by a set of dot-delimited action names.
 * `invoice.paid` → `invoice.*`; `billing.invoice.paid` → `billing.*`, `billing.invoice.*`.
 */
export function actionFamilies(names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) out.add(`${parts.slice(0, i).join(".")}.*`);
  }
  return [...out].sort();
}

/**
 * Autocomplete for the action filter: catalog names plus their families,
 * matching `input` case-insensitively (prefix matches first), minus what is
 * already selected. Empty input lists families first, then names.
 */
export function actionSuggestions(
  names: string[],
  input: string,
  selected: string[] = [],
  limit = 12,
): string[] {
  const families = actionFamilies(names);
  const all = [...families, ...[...new Set(names)].sort()].filter((s) => !selected.includes(s));
  const needle = input.trim().toLowerCase();
  if (!needle) return all.slice(0, limit);
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const s of all) {
    const lower = s.toLowerCase();
    if (lower.startsWith(needle)) prefix.push(s);
    else if (lower.includes(needle)) contains.push(s);
  }
  return [...prefix, ...contains].slice(0, limit);
}
