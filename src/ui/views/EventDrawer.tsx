import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eraser } from "lucide-react";
import type { AuditEvent, AuditSection } from "../types.ts";
import { AuditApiError } from "../types.ts";
import { AUDIT_SECTIONS } from "../../schema.ts";
import { eraseEvent, getEvent } from "../api.ts";
import { useToast } from "@xtandard/kit/ui";
import { Button } from "@xtandard/kit/ui";
import { TextArea } from "@xtandard/kit/ui";
import { JsonCodeEditor } from "../components/JsonCodeEditor.tsx";
import {
  ConfirmDialog,
  CopyButton,
  Drawer,
  KeyValue,
  LoadingRow,
  Mono,
  OutcomeBadge,
  ToneBadge,
} from "../components/audit-bits.tsx";
import { erasedSections, formatDateTime, isErasedValue, relativeTime } from "../lib/format.ts";
import { cn } from "@xtandard/kit/ui";

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function Block({
  title,
  erased,
  copy,
  children,
}: {
  title: string;
  erased?: boolean;
  /** Raw JSON for the block's copy button. */
  copy?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {erased && <ToneBadge tone="warning">erased</ToneBadge>}
        {copy !== undefined && !erased ? (
          <CopyButton value={copy} label={`Copy ${title.toLowerCase()} JSON`} className="ml-auto" />
        ) : null}
      </div>
      {erased ? (
        <p className="m-0 text-[13px] italic text-muted-foreground">
          This section was erased. Its digest is kept, so the chain still verifies.
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function EventBody({ event }: { event: AuditEvent }) {
  const erased = new Set(erasedSections(event));
  const sectionErased = (s: AuditSection, value: unknown) => erased.has(s) || isErasedValue(value);
  const contextEntries = Object.entries(event.context ?? {}).filter(
    ([k, v]) => v !== undefined && k !== "$erased",
  );
  const hasMetadata = event.metadata && Object.keys(event.metadata).length > 0;

  return (
    <div className="flex flex-col">
      <Block title="Summary">
        <dl className="m-0">
          <KeyValue label="Event id" copy={event.id}>
            <Mono>{event.id}</Mono>
          </KeyValue>
          <KeyValue label="Tenant" copy={event.tenant}>
            <Mono>{event.tenant}</Mono>
          </KeyValue>
          <KeyValue label="Occurred">
            {formatDateTime(event.occurredAt)}{" "}
            <span className="text-muted-foreground">({relativeTime(event.occurredAt)})</span>
          </KeyValue>
          <KeyValue label="Recorded">{formatDateTime(event.recordedAt)}</KeyValue>
          <KeyValue label="Outcome">
            <OutcomeBadge outcome={event.outcome} />
          </KeyValue>
          {(event.description !== undefined || erased.has("description")) && (
            <KeyValue label="Description">
              {sectionErased("description", event.description) ? (
                <span className="italic text-muted-foreground">erased</span>
              ) : (
                event.description
              )}
            </KeyValue>
          )}
        </dl>
      </Block>

      <Block title="Actor" erased={sectionErased("actor", event.actor)} copy={json(event.actor)}>
        <dl className="m-0">
          <KeyValue label="Id" copy={event.actor?.id}>
            <Mono>{event.actor?.id}</Mono>
          </KeyValue>
          {event.actor?.type && <KeyValue label="Type">{event.actor.type}</KeyValue>}
          {event.actor?.name && <KeyValue label="Name">{event.actor.name}</KeyValue>}
          {event.actor?.email && <KeyValue label="Email">{event.actor.email}</KeyValue>}
        </dl>
        {event.actor?.metadata && Object.keys(event.actor.metadata).length > 0 && (
          <div className="mt-2">
            <JsonCodeEditor value={json(event.actor.metadata)} onChange={() => {}} readOnly />
          </div>
        )}
      </Block>

      <Block
        title={`Targets (${Array.isArray(event.targets) ? event.targets.length : 0})`}
        erased={sectionErased("targets", event.targets)}
        copy={json(event.targets)}
      >
        {Array.isArray(event.targets) && event.targets.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {event.targets.map((t, i) => (
              <li
                key={`${t.type}:${t.id}:${i}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
              >
                <ToneBadge tone="muted">{t.type}</ToneBadge>
                <Mono className="min-w-0 truncate">{t.id}</Mono>
                {t.name && <span className="text-[13px] text-muted-foreground">{t.name}</span>}
                <CopyButton value={t.id} label={`Copy target id ${t.id}`} className="ml-auto" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">No targets.</p>
        )}
      </Block>

      <Block
        title="Context"
        erased={sectionErased("context", event.context)}
        copy={json(event.context)}
      >
        {contextEntries.length > 0 ? (
          <dl className="m-0">
            {contextEntries.map(([k, v]) => (
              <KeyValue key={k} label={k}>
                {typeof v === "string" ? v : <Mono>{JSON.stringify(v)}</Mono>}
              </KeyValue>
            ))}
          </dl>
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">No context captured.</p>
        )}
      </Block>

      <Block
        title="Metadata"
        erased={sectionErased("metadata", event.metadata)}
        copy={json(event.metadata)}
      >
        {hasMetadata ? (
          <JsonCodeEditor value={json(event.metadata)} onChange={() => {}} readOnly />
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">No metadata.</p>
        )}
      </Block>

      <Block title="Integrity">
        <dl className="m-0">
          <KeyValue label="Sequence">
            <span className="tabular-nums">#{event.seq}</span>
          </KeyValue>
          <KeyValue label="Hash" copy={event.integrity.hash}>
            <Mono className="text-[11px]">{event.integrity.hash}</Mono>
          </KeyValue>
          <KeyValue label="Prev hash" copy={event.integrity.prevHash}>
            <Mono className="text-[11px]">{event.integrity.prevHash}</Mono>
          </KeyValue>
          {Object.entries(event.integrity.digests ?? {}).map(([section, digest]) => (
            <KeyValue key={section} label={`Digest · ${section}`} copy={digest}>
              <Mono
                className={cn("text-[11px]", erased.has(section as AuditSection) && "text-warning")}
              >
                {digest}
              </Mono>
            </KeyValue>
          ))}
          <KeyValue label="Erased">
            {erased.size === 0 ? (
              <span className="text-muted-foreground">none</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {[...erased].map((s) => (
                  <ToneBadge key={s} tone="warning">
                    {s}
                  </ToneBadge>
                ))}
              </span>
            )}
          </KeyValue>
        </dl>
      </Block>
    </div>
  );
}

function EraseDialog({
  event,
  open,
  onClose,
}: {
  event: AuditEvent;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const already = new Set(erasedSections(event));
  const [sections, setSections] = React.useState<AuditSection[]>(() =>
    AUDIT_SECTIONS.filter((s) => !already.has(s)),
  );
  const [reason, setReason] = React.useState("");

  const mutation = useMutation({
    mutationFn: () =>
      eraseEvent(event.tenant, event.id, {
        sections,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(["event", updated.tenant, updated.id], updated);
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast.add("success", "Event erased", `${sections.join(", ")} removed from ${updated.id}`);
      onClose();
    },
    onError: (err: unknown) =>
      toast.add("error", err instanceof AuditApiError ? err.body.error : "Failed to erase event"),
  });

  const toggle = (s: AuditSection) =>
    setSections((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={() => mutation.mutate()}
      title="Erase event data"
      confirmLabel="Erase"
      danger
      loading={mutation.isPending}
      confirmDisabled={sections.length === 0}
    >
      <p className="m-0 text-[13px] text-muted-foreground">
        Erasure removes the content of the selected sections permanently (e.g. for a GDPR request).
        The event, its sequence number and its digests stay, so the hash chain still verifies and
        the erasure itself is recorded in the log.
      </p>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 text-xs font-medium text-foreground">Sections</legend>
        {AUDIT_SECTIONS.map((s) => (
          <label
            key={s}
            className={cn(
              "flex items-center gap-2 text-[13px]",
              already.has(s) ? "text-muted-foreground" : "cursor-pointer text-foreground",
            )}
          >
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--destructive)]"
              checked={already.has(s) || sections.includes(s)}
              disabled={already.has(s)}
              onChange={() => toggle(s)}
            />
            <span className="font-mono text-[12px]">{s}</span>
            {already.has(s) && <span className="text-xs">(already erased)</span>}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">Reason</span>
        <TextArea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. GDPR erasure request #1234"
        />
      </label>
    </ConfirmDialog>
  );
}

/**
 * Event detail side sheet: actor/targets/context/metadata, the integrity block
 * (seq, hash, prevHash, per-section digests, erased sections), copy buttons,
 * and — for admins with `event:erase` — the erase action.
 */
export function EventDrawer({
  tenant,
  id,
  initial,
  canErase,
  onClose,
}: {
  tenant: string;
  id: string;
  /** The row as listed (shown instantly while the fresh copy loads). */
  initial?: AuditEvent;
  canErase: boolean;
  onClose: () => void;
}) {
  const [erasing, setErasing] = React.useState(false);
  const query = useQuery({
    queryKey: ["event", tenant, id],
    queryFn: () => getEvent(tenant, id),
    placeholderData: initial,
  });
  const event = query.data;

  return (
    <Drawer
      open
      onClose={onClose}
      title={event?.action ?? id}
      subtitle={
        event ? (
          <>
            <span className="font-mono">#{event.seq}</span> · {formatDateTime(event.occurredAt)}
          </>
        ) : undefined
      }
      actions={
        event ? (
          <div className="flex items-center gap-1">
            <CopyButton value={json(event)} label="Copy event JSON" className="size-8" />
            {canErase && erasedSections(event).length < AUDIT_SECTIONS.length && (
              <Button
                variant="danger"
                size="sm"
                icon={<Eraser className="size-3.5" />}
                onClick={() => setErasing(true)}
              >
                Erase
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {query.isLoading && !event ? (
        <LoadingRow label="Loading event…" />
      ) : !event ? (
        <p className="text-[13px] text-muted-foreground">Event not found.</p>
      ) : (
        <>
          <EventBody event={event} />
          {erasing && <EraseDialog event={event} open onClose={() => setErasing(false)} />}
        </>
      )}
    </Drawer>
  );
}
