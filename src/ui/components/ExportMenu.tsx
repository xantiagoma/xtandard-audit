import * as React from "react";
import { Menu } from "@base-ui-components/react/menu";
import { ChevronDown, Download } from "lucide-react";
import type { ExportFormat } from "../types.ts";
import { AuditApiError } from "../types.ts";
import { exportEvents, type EventQueryParams } from "../api.ts";
import { exportFileName } from "../lib/format.ts";
import { portalContainerRef } from "@xtandard/kit/ui";
import { cn } from "@xtandard/kit/ui";
import { useToast } from "@xtandard/kit/ui";
import { Spinner } from "./audit-bits.tsx";

const FORMATS: { value: ExportFormat; label: string; description: string }[] = [
  { value: "csv", label: "CSV", description: "Spreadsheet-friendly, one row per event" },
  { value: "json", label: "JSON", description: "A JSON array of events" },
  { value: "jsonl", label: "JSONL", description: "One event per line (streaming / SIEM)" },
  {
    value: "bundle",
    label: "Verifiable bundle",
    description: "Events + signed checkpoints, checkable offline",
  },
];

/** Hand a Blob to the browser as a file download. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * The Events view's export menu. Exports honor the current filters (the same
 * API query the list runs, minus paging) and are per tenant: with "All tenants"
 * selected the menu is disabled.
 */
export function ExportMenu({
  tenant,
  query,
  disabledReason,
}: {
  tenant: string;
  query: EventQueryParams;
  /** When set, the trigger is disabled with this tooltip. */
  disabledReason?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = React.useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const { blob, contentDisposition } = await exportEvents(tenant, format, query);
      saveBlob(blob, exportFileName(tenant, format, contentDisposition));
      toast.add("success", "Export ready", `${exportFileName(tenant, format, contentDisposition)}`);
    } catch (err) {
      toast.add(
        "error",
        "Export failed",
        err instanceof AuditApiError ? err.body.error : "The export could not be downloaded.",
      );
    } finally {
      setBusy(null);
    }
  };

  const disabled = Boolean(disabledReason) || busy !== null;

  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        title={disabledReason}
        className={cn(
          "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border bg-secondary/60 px-3.5 text-[13px] font-medium text-foreground outline-none transition-colors",
          "hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        {busy ? <Spinner className="size-3.5" /> : <Download className="size-3.5" />}
        Export
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </Menu.Trigger>
      <Menu.Portal container={portalContainerRef()}>
        <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <Menu.Popup
            className={cn(
              "w-72 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none",
              "origin-[var(--transform-origin)] transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            {FORMATS.map((f) => (
              <Menu.Item
                key={f.value}
                onClick={() => run(f.value)}
                className="flex cursor-pointer select-none flex-col rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-accent/15"
              >
                <span className="font-medium">{f.label}</span>
                <span className="text-xs text-muted-foreground">{f.description}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
