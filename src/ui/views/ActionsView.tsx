import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { ActionDefinition } from "../types.ts";
import { AuditApiError } from "../types.ts";
import type { ShellContext } from "../App.tsx";
import { deleteAction, listActions, updateAction } from "../api.ts";
import { useToast } from "@xtandard/kit/ui";
import { Button } from "@xtandard/kit/ui";
import { TextArea, TextInput } from "@xtandard/kit/ui";
import {
  ConfirmDialog,
  EmptyCard,
  LoadingRow,
  ModalDialog,
  Page,
  PageHeader,
  ToneBadge,
} from "../components/audit-bits.tsx";
import { groupActions, isEditableAction } from "../lib/format.ts";

const errMessage = (err: unknown, fallback: string): string =>
  err instanceof AuditApiError ? err.body.error : fallback;

const NAME_PATTERN = /^[a-zA-Z0-9._:-]+$/;

/** Create (no `action`) or edit description/group of a UI-sourced catalog entry. */
function ActionDialog({ action, onClose }: { action?: ActionDefinition; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = React.useState(action?.name ?? "");
  const [description, setDescription] = React.useState(action?.description ?? "");
  const [group, setGroup] = React.useState(action?.group ?? "");
  const creating = !action;
  const validName = NAME_PATTERN.test(name.trim());

  const mutation = useMutation({
    mutationFn: () => {
      const {
        name: _n,
        source: _s,
        createdAt: _c,
        updatedAt: _u,
        ...rest
      } = action ?? {
        name: "",
      };
      return updateAction(name.trim(), {
        ...rest,
        description: description.trim() || undefined,
        group: group.trim() || undefined,
      });
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["actions"] });
      toast.add("success", creating ? `Action "${saved.name}" created` : "Action saved");
      onClose();
    },
    onError: (err: unknown) => toast.add("error", errMessage(err, "Failed to save action")),
  });

  return (
    <ModalDialog
      open
      onClose={onClose}
      title={creating ? "New action" : action.name}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={!validName}
            onClick={() => mutation.mutate()}
          >
            {creating ? "Create action" : "Save changes"}
          </Button>
        </>
      }
    >
      {creating && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">Name</span>
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="invoice.paid"
            className="font-mono"
          />
          <span className="text-xs text-muted-foreground">
            Dot-delimited; letters, digits and <code className="font-mono">. _ - :</code>.
          </span>
        </label>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">Description</span>
        <TextArea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this action mean?"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">Group</span>
        <TextInput value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Billing" />
      </label>
    </ModalDialog>
  );
}

/**
 * The action catalog: documentation for every action the log knows, grouped.
 * Code-defined entries (`defineActions`) are read-only here — code is their
 * source of truth; UI-sourced entries can be edited and deleted.
 */
export function ActionsView({ ctx }: { ctx: ShellContext }) {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["actions"], queryFn: listActions });
  const [editing, setEditing] = React.useState<ActionDefinition | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<ActionDefinition | null>(null);

  const canEdit = !ctx.readonly && !ctx.portal && ctx.can("action:update");
  const canDelete = !ctx.readonly && !ctx.portal && ctx.can("action:delete");

  const del = useMutation({
    mutationFn: (name: string) => deleteAction(name),
    onSuccess: (_v, name) => {
      qc.invalidateQueries({ queryKey: ["actions"] });
      toast.add("success", `Action "${name}" deleted`);
      setDeleting(null);
    },
    onError: (err: unknown) => toast.add("error", errMessage(err, "Failed to delete action")),
  });

  const groups = groupActions(query.data ?? []);

  return (
    <Page>
      <PageHeader
        title="Actions"
        description={
          ctx.portal
            ? "The kinds of events this log records."
            : "The action catalog. Entries defined in code are read-only here; entries added in the panel can be edited."
        }
        actions={
          canEdit ? (
            <Button
              variant="primary"
              icon={<Plus className="size-3.5" />}
              onClick={() => setEditing("new")}
            >
              New action
            </Button>
          ) : undefined
        }
      />

      {query.isLoading ? (
        <LoadingRow label="Loading actions…" />
      ) : query.isError ? (
        <EmptyCard>Failed to load the action catalog.</EmptyCard>
      ) : groups.length === 0 ? (
        <EmptyCard>
          No actions in the catalog. Define them in code with{" "}
          <code className="font-mono">defineActions</code>
          {canEdit ? " or add one here" : ""}.
        </EmptyCard>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {groups.map(({ group, actions }) => (
            <section key={group}>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </h2>
              <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
                <ul className="divide-y divide-border">
                  {actions.map((a) => {
                    const editable = isEditableAction(a);
                    return (
                      <li key={a.name} className="flex items-start gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[13px] font-medium text-foreground">
                              {a.name}
                            </span>
                            {a.source === "code" && <ToneBadge tone="muted">code</ToneBadge>}
                            {a.deprecated && <ToneBadge tone="warning">deprecated</ToneBadge>}
                          </div>
                          {a.description ? (
                            <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">
                              {a.description}
                            </p>
                          ) : null}
                          {a.targets && a.targets.length > 0 ? (
                            <p className="m-0 mt-1 text-xs text-muted-foreground">
                              Targets: <span className="font-mono">{a.targets.join(", ")}</span>
                            </p>
                          ) : null}
                        </div>
                        {ctx.can("event:read") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => ctx.go("/events", { actions: a.name })}
                          >
                            Events
                          </Button>
                        )}
                        {canEdit && editable && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Edit ${a.name}`}
                            title="Edit"
                            onClick={() => setEditing(a)}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        )}
                        {canDelete && editable && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete ${a.name}`}
                            title="Delete"
                            onClick={() => setDeleting(a)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <ActionDialog
          action={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting.name)}
        title="Delete action"
        confirmLabel="Delete"
        danger
        loading={del.isPending}
      >
        <p className="m-0 text-[13px] text-muted-foreground">
          Remove <span className="font-mono text-foreground">{deleting?.name}</span> from the
          catalog? Recorded events keep their action; only the documentation goes.
        </p>
      </ConfirmDialog>
    </Page>
  );
}
