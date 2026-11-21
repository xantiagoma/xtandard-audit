import * as React from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { Check, Copy, X } from "lucide-react";
import type { AuditEvent } from "../types.ts";
import { outcomeTone, streamHealthTone, type StreamHealth } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { portalContainerRef } from "../lib/portal-container.ts";
import { Button } from "./ui-bits.tsx";
import { useToast } from "./Toast.tsx";

/* ─── Spinner ───────────────────────────────────────────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={cn("animate-spin", className)}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="24"
        strokeDashoffset="12"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LoadingRow({ label }: { label: string }) {
  return (
    <div className="mt-8 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}

/* ─── Badges ────────────────────────────────────────────────────────────────── */

const badgeBase =
  "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide";

export function OutcomeBadge({ outcome }: { outcome: AuditEvent["outcome"] }) {
  if (!outcome) return <span className="text-xs text-muted-foreground">—</span>;
  return <span className={cn(badgeBase, outcomeTone(outcome))}>{outcome}</span>;
}

export function StreamHealthBadge({ health }: { health: StreamHealth }) {
  return <span className={cn(badgeBase, streamHealthTone(health))}>{health}</span>;
}

export function ToneBadge({
  tone,
  children,
}: {
  tone: "success" | "warning" | "destructive" | "accent" | "muted";
  children: React.ReactNode;
}) {
  const tones = {
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-warning",
    destructive: "border-destructive/30 bg-destructive/10 text-destructive",
    accent: "border-accent/30 bg-accent/10 text-accent",
    muted: "border-border bg-secondary/60 text-muted-foreground",
  };
  return <span className={cn(badgeBase, tones[tone])}>{children}</span>;
}

/* ─── Mono ──────────────────────────────────────────────────────────────────── */

/** Keys/ids/hashes render in JetBrains Mono per the design system. */
export function Mono({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("font-mono text-[12px] text-foreground", className)}>{children}</span>;
}

/* ─── CopyButton ────────────────────────────────────────────────────────────── */

/** Icon button that copies `value` to the clipboard (brief check-mark feedback). */
export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  /** Accessible name, e.g. "Copy event id". */
  label?: string;
  className?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          toast.add("error", "Copy failed", "Clipboard access was denied by the browser.");
        }
      }}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
        "hover:bg-secondary/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/* ─── PageHeader ────────────────────────────────────────────────────────────── */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/* ─── SectionCard ───────────────────────────────────────────────────────────── */

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

/* ─── StatCard ──────────────────────────────────────────────────────────────── */

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", tone)}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* ─── KeyValue ──────────────────────────────────────────────────────────────── */

/** A two-column definition list row (label / value). */
export function KeyValue({
  label,
  children,
  copy,
}: {
  label: string;
  children: React.ReactNode;
  /** When set, a copy button for this raw value is shown. */
  copy?: string;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-3 py-1.5">
      <dt className="pt-0.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 items-start gap-1 text-[13px] text-foreground">
        <span className="min-w-0 flex-1 break-all">{children}</span>
        {copy ? <CopyButton value={copy} label={`Copy ${label.toLowerCase()}`} /> : null}
      </dd>
    </div>
  );
}

/* ─── ModalDialog ───────────────────────────────────────────────────────────── */

export function ModalDialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal container={portalContainerRef()}>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-2xl outline-none",
            wide ? "max-w-2xl" : "max-w-md",
          )}
        >
          <div className="border-b border-border px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold text-foreground">
              {title}
            </Dialog.Title>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
            {children}
          </div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ─── ConfirmDialog ─────────────────────────────────────────────────────────── */

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  danger,
  loading,
  children,
  confirmDisabled,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  confirmDisabled?: boolean;
}) {
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={loading}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </ModalDialog>
  );
}

/* ─── Drawer ────────────────────────────────────────────────────────────────── */

/** A right-hand side sheet (the event detail). Closes on Escape / backdrop click. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal container={portalContainerRef()}>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="drawer"
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl outline-none",
            "transition-transform data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full",
          )}
        >
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate font-mono text-[15px] font-semibold text-foreground">
                {title}
              </Dialog.Title>
              {subtitle ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
              ) : null}
            </div>
            {actions}
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-secondary/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ─── EmptyCard ─────────────────────────────────────────────────────────────── */

export function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border border-border bg-card px-4 py-16 text-center">
      <p className="text-[13px] text-muted-foreground">{children}</p>
    </div>
  );
}

/** Page wrapper with the shared max width and gutters. */
export function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</div>;
}
