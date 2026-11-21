import * as React from "react";
import { X } from "lucide-react";
import { actionSuggestions, isFamily } from "../lib/filters.ts";
import { cn } from "../lib/utils.ts";

/**
 * Multi-value action filter: chips plus a type-ahead over the catalog's names
 * and their families (`invoice.*`). Enter adds the highlighted suggestion (or
 * the typed text verbatim — unknown actions and hand-written families are
 * valid filters), Backspace on an empty input removes the last chip.
 *
 * The suggestion list renders inline (absolutely positioned, not portaled) so
 * it stays inside the embed's scoped stylesheet.
 */
export function ActionFilter({
  value,
  onChange,
  names,
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Known action names (catalog + recently seen). */
  names: string[];
  className?: string;
}) {
  const [input, setInput] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  const suggestions = actionSuggestions(names, input, value);
  const typed = input.trim();

  const add = (action: string) => {
    const a = action.trim();
    if (a && !value.includes(a)) onChange([...value, a]);
    setInput("");
    setHighlight(0);
  };
  const remove = (action: string) => onChange(value.filter((v) => v !== action));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(suggestions.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = open ? suggestions[highlight] : undefined;
      // Exact typed text wins over a fuzzy highlight (lets you add `inv*` verbatim).
      if (typed && (!picked || !picked.toLowerCase().startsWith(typed.toLowerCase()))) add(typed);
      else if (picked) add(picked);
      else if (typed) add(typed);
    } else if (e.key === "Backspace" && !input && value.length > 0) {
      remove(value[value.length - 1]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-secondary/40 px-2 py-1 text-[13px] transition-colors",
          "hover:bg-secondary/60 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((action) => (
          <span
            key={action}
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]",
              isFamily(action)
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border bg-card text-foreground",
            )}
          >
            {action}
            <button
              type="button"
              aria-label={`Remove ${action}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(action);
              }}
              className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label="Filter by action"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder={value.length === 0 ? "Actions (e.g. invoice.*)" : ""}
          className="h-7 min-w-[8rem] flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-muted-foreground"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Action suggestions"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === highlight}
              // mousedown (not click) so the input's blur doesn't close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 font-mono text-[12px]",
                i === highlight && "bg-accent/15",
              )}
            >
              <span className="truncate">{s}</span>
              {isFamily(s) && (
                <span className="font-sans text-[11px] text-muted-foreground">family</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
