import type {
  BulkEnvironmentVariablePreviewItem,
  EnvironmentVariableAuditEventData,
  EnvironmentVariableData,
} from "@dx/api";
import { DateTime } from "effect";
import { Check } from "lucide-react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";

export interface BulkPreview {
  readonly items: ReadonlyArray<BulkEnvironmentVariablePreviewItem>;
  readonly canApply: boolean;
}

export function CompactEnvironmentVariableDialogs({
  fieldId,
  mode,
  name,
  value,
  kind,
  bulk,
  preview,
  conflictBehavior,
  error,
  nameRef,
  onNameChange,
  onValueChange,
  onKindChange,
  onBulkChange,
  onConflictBehavior,
  onCreate,
  onApplyBulk,
  onClose,
}: {
  readonly fieldId: string;
  readonly mode?: "add" | "bulk";
  readonly name: string;
  readonly value: string;
  readonly kind: "secret" | "variable";
  readonly bulk: string;
  readonly preview?: BulkPreview;
  readonly conflictBehavior: "reject" | "replace";
  readonly error?: string;
  readonly nameRef: RefObject<HTMLInputElement | null>;
  readonly onNameChange: (value: string) => void;
  readonly onValueChange: (value: string) => void;
  readonly onKindChange: (kind: "secret" | "variable") => void;
  readonly onBulkChange: (value: string) => void;
  readonly onConflictBehavior: (value: "reject" | "replace") => void;
  readonly onCreate: (event: FormEvent) => void;
  readonly onApplyBulk: () => void;
  readonly onClose: () => void;
}) {
  const assignmentCount = bulk
    .split("\n")
    .filter((line) => line.trim() && line.includes("=")).length;
  return (
    <>
      <DialogRoot
        open={mode === "add"}
        onOpenChange={(open) => !open && onClose()}
      >
        <DialogContent
          className="environment-variable-dialog"
          backdropClassName="environment-dialog-backdrop"
        >
          <DialogTitle>Add Secret or Env Var</DialogTitle>
          <form className="environment-dialog-form" onSubmit={onCreate}>
            <div className="environment-dialog-fields">
              <label htmlFor={`${fieldId}-name`}>
                Name
                <Input
                  id={`${fieldId}-name`}
                  ref={nameRef}
                  autoFocus
                  value={name}
                  placeholder="MY_VAR"
                  onChange={(event) => onNameChange(event.target.value)}
                />
              </label>
              <label htmlFor={`${fieldId}-value`}>
                Value
                <Input
                  id={`${fieldId}-value`}
                  type={kind === "secret" ? "password" : "text"}
                  value={value}
                  placeholder="Value"
                  onChange={(event) => onValueChange(event.target.value)}
                />
              </label>
              <div className="environment-dialog-secret-option">
                <label className="environment-dialog-checkbox">
                  <input
                    type="checkbox"
                    checked={kind === "secret"}
                    onChange={(event) =>
                      onKindChange(event.target.checked ? "secret" : "variable")
                    }
                  />
                  <span className="environment-dialog-checkbox-control">
                    <Check aria-hidden="true" />
                  </span>
                  <span>Secret</span>
                </label>
                <p>
                  Secret values are hidden after saving. Env var values stay
                  visible here.
                </p>
              </div>
              {error ? <p role="alert">{error}</p> : null}
            </div>
            <div className="environment-dialog-actions">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name || !value}>
                Add
              </Button>
            </div>
          </form>
        </DialogContent>
      </DialogRoot>
      <DialogRoot
        open={mode === "bulk"}
        onOpenChange={(open) => !open && onClose()}
      >
        <DialogContent
          className="environment-variable-dialog environment-bulk-dialog"
          backdropClassName="environment-dialog-backdrop"
        >
          <div className="environment-dialog-heading">
            <DialogTitle>Bulk Add Secrets &amp; Env Vars</DialogTitle>
            <DialogDescription>
              Paste assignments like NAME=VALUE, one per line.
            </DialogDescription>
          </div>
          <div className="environment-dialog-fields">
            <label htmlFor={`${fieldId}-bulk`}>
              Assignments
              <Textarea
                id={`${fieldId}-bulk`}
                autoFocus
                value={bulk}
                placeholder={"API_KEY='secret-value'\nNODE_ENV=development"}
                onChange={(event) => onBulkChange(event.target.value)}
              />
            </label>
            <p>
              {assignmentCount} assignment{assignmentCount === 1 ? "" : "s"}
            </p>
            <label className="environment-dialog-checkbox">
              <input
                type="checkbox"
                checked={kind === "secret"}
                onChange={(event) =>
                  onKindChange(event.target.checked ? "secret" : "variable")
                }
              />
              <span className="environment-dialog-checkbox-control">
                <Check aria-hidden="true" />
              </span>
              <span>Add all as secrets</span>
            </label>
            <SettingsSelect
              label="Conflict behavior"
              value={conflictBehavior}
              onValueChange={(value) =>
                onConflictBehavior(value as "reject" | "replace")
              }
              options={[
                ["reject", "Reject conflicts"],
                ["replace", "Replace conflicts"],
              ]}
            />
            {preview ? (
              <ul className="environment-preview">
                {preview.items.map((item) => (
                  <li
                    key={`${item.line}:${item.name}`}
                    data-status={item.status}
                  >
                    Line {item.line}: {item.name} — {item.status}
                    {item.message ? `: ${item.message}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
          </div>
          <div className="environment-dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!bulk.trim()} onClick={onApplyBulk}>
              Add All
            </Button>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

export function ConfiguredEnvironmentVariables({
  title = "Configured values",
  emptyMessage = "No environment variables in this scope.",
  actions,
  loading,
  loadError,
  items,
  canMutate,
  onReload,
  onRotate,
  onToggle,
  onDelete,
}: {
  readonly title?: string;
  readonly emptyMessage?: string;
  readonly actions?: ReactNode;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly items: ReadonlyArray<EnvironmentVariableData>;
  readonly canMutate: boolean;
  readonly onReload: () => void;
  readonly onRotate: (
    item: EnvironmentVariableData,
    trigger: HTMLElement,
  ) => void;
  readonly onToggle: (item: EnvironmentVariableData) => void;
  readonly onDelete: (
    item: EnvironmentVariableData,
    trigger: HTMLElement,
  ) => void;
}) {
  return (
    <SettingsCard title={title} actions={actions}>
      {loading ? (
        <p aria-busy="true">Loading…</p>
      ) : loadError ? (
        <p role="alert">
          {loadError}{" "}
          <Button size="xs" onClick={onReload}>
            Try again
          </Button>
        </p>
      ) : items.length === 0 ? (
        <p className="settings-card-empty">{emptyMessage}</p>
      ) : (
        items.map((item) => (
          <SettingsRow
            key={item.reference.id}
            title={item.name}
            badge={`${item.kind} · ${item.enabled ? "enabled" : "disabled"}`}
            description={
              <>
                <span>
                  {item.scope} · {item.source}
                </span>
                <code>{item.kind === "secret" ? "••••••••" : item.value}</code>
              </>
            }
            control={
              canMutate ? (
                <div className="environment-row-actions">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={(event) => onRotate(item, event.currentTarget)}
                  >
                    {item.kind === "secret" ? "Rotate" : "Update"}
                  </Button>
                  <SettingsToggle
                    label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`}
                    checked={item.enabled}
                    onCheckedChange={() => onToggle(item)}
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={(event) => onDelete(item, event.currentTarget)}
                  >
                    Delete
                  </Button>
                </div>
              ) : null
            }
          />
        ))
      )}
    </SettingsCard>
  );
}

export function EnvironmentVariableHistory({
  loading,
  loadError,
  moreError,
  items,
  hasMore,
  loadingMore,
  onReload,
  onLoadMore,
}: {
  readonly loading: boolean;
  readonly loadError?: string;
  readonly moreError?: string;
  readonly items: ReadonlyArray<EnvironmentVariableAuditEventData>;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onReload: () => void;
  readonly onLoadMore: () => void;
}) {
  return (
    <SettingsCard title="History">
      {loading ? (
        <p aria-busy="true">Loading…</p>
      ) : loadError ? (
        <p role="alert">
          {loadError}{" "}
          <Button size="xs" onClick={onReload}>
            Try again
          </Button>
        </p>
      ) : items.length === 0 ? (
        <p className="settings-card-empty">No configuration changes yet.</p>
      ) : (
        <>
          {items.map((item) => (
            <SettingsRow
              key={item.id}
              title={`${item.action} ${item.name}`}
              badge={item.kind}
              description={`${item.actorName} · ${new Date(DateTime.formatIso(item.occurredAt)).toLocaleString()}`}
            />
          ))}
          {moreError === undefined ? null : <p role="alert">{moreError}</p>}
          {hasMore ? (
            <Button
              disabled={loadingMore}
              onClick={onLoadMore}
              variant="outline"
            >
              {loadingMore ? "Loading…" : "Load older events"}
            </Button>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}

export function EnvironmentVariableDialogs({
  fieldId,
  rotate,
  remove,
  value,
  finalFocus,
  onValueChange,
  onRotateOpenChange,
  onRotate,
  onRemoveOpenChange,
  onRemove,
}: {
  readonly fieldId: string;
  readonly rotate?: EnvironmentVariableData;
  readonly remove?: EnvironmentVariableData;
  readonly value: string;
  readonly finalFocus: RefObject<HTMLElement | null>;
  readonly onValueChange: (value: string) => void;
  readonly onRotateOpenChange: (open: boolean) => void;
  readonly onRotate: () => void;
  readonly onRemoveOpenChange: (open: boolean) => void;
  readonly onRemove: () => void;
}) {
  return (
    <>
      <DialogRoot open={rotate !== undefined} onOpenChange={onRotateOpenChange}>
        {rotate ? (
          <DialogContent finalFocus={finalFocus}>
            <DialogTitle>
              {rotate.kind === "secret" ? "Rotate" : "Update"} {rotate.name}
            </DialogTitle>
            <DialogDescription>
              Enter a replacement value. Secrets are masked immediately.
            </DialogDescription>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onRotate();
              }}
            >
              <label htmlFor={`${fieldId}-rotate`}>
                New value
                <Input
                  id={`${fieldId}-rotate`}
                  autoFocus
                  type={rotate.kind === "secret" ? "password" : "text"}
                  value={value}
                  required
                  onChange={(event) => onValueChange(event.target.value)}
                />
              </label>
              <Button type="submit">
                {rotate.kind === "secret" ? "Rotate" : "Update"}
              </Button>
            </form>
          </DialogContent>
        ) : null}
      </DialogRoot>
      <DialogRoot open={remove !== undefined} onOpenChange={onRemoveOpenChange}>
        {remove ? (
          <DialogContent finalFocus={finalFocus}>
            <DialogTitle>Delete {remove.name}?</DialogTitle>
            <DialogDescription>
              This removes the value from new commands. Processes that are
              already running keep the environment they were launched with.
            </DialogDescription>
            <div className="environment-row-actions">
              <Button
                variant="outline"
                onClick={() => onRemoveOpenChange(false)}
              >
                Cancel
              </Button>
              <Button onClick={onRemove}>Delete</Button>
            </div>
          </DialogContent>
        ) : null}
      </DialogRoot>
    </>
  );
}
