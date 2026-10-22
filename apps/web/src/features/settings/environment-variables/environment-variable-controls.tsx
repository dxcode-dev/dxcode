import { Menu } from "@base-ui/react/menu";
import type {
  EnvironmentVariableAuditEventData,
  EnvironmentVariableData,
} from "@dx/api";
import {
  EMPTY_SECRET_PROBLEM,
  type EnvironmentVariableKind,
  isReservedEnvironmentVariableName,
  isWeakSecretValue,
  looksLikeSecretEnvironmentVariable,
  MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS,
  parseEnvironmentVariableAssignments,
} from "@dx/domain";
import { Link } from "@tanstack/react-router";
import { DateTime } from "effect";
import { ArrowUpRight, Check, Ellipsis, Plus, Search } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useRef } from "react";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { SettingsCard } from "../settings-primitives.js";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const relativeTime = (value: DateTime.Utc) => (now: number) =>
  formatRelativeTime({ epochMilliseconds: DateTime.toEpochMillis(value) }, now);

function Checkbox({
  checked,
  onChange,
  children,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <label className="environment-dialog-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="environment-dialog-checkbox-control">
        <Check aria-hidden="true" />
      </span>
      <span>{children}</span>
    </label>
  );
}

/** dx hides every occurrence of a secret value in agent command output. */
const SHORT_VALUE_WARNING =
  "This value is short or common. dx hides every occurrence of a secret in command output, so this would hide unrelated text too.";

/** What a secret's value field says before it can be saved. */
const secretValueNotice = (secret: boolean, value: string) =>
  !secret
    ? undefined
    : value.length === 0
      ? { tone: "error" as const, text: EMPTY_SECRET_PROBLEM }
      : isWeakSecretValue(value)
        ? { tone: "warning" as const, text: SHORT_VALUE_WARNING }
        : undefined;

function ValueNotice({
  id,
  notice,
}: {
  readonly id: string;
  readonly notice?: {
    readonly tone: "error" | "warning";
    readonly text: string;
  };
}) {
  return notice === undefined ? null : (
    <p
      id={id}
      className={
        notice.tone === "error"
          ? "environment-field-error"
          : "environment-field-warning"
      }
    >
      {notice.text}
    </p>
  );
}

function FieldError({
  id,
  children,
}: {
  readonly id: string;
  readonly children?: string;
}) {
  return children === undefined ? null : (
    <p id={id} className="environment-field-error">
      {children}
    </p>
  );
}

export function AddEnvironmentVariableDialog({
  open,
  fieldId,
  name,
  value,
  secret,
  nameError,
  valueError,
  formErrors,
  pending,
  onNameChange,
  onValueChange,
  onSecretChange,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  readonly fieldId: string;
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly nameError?: string;
  readonly valueError?: string;
  readonly formErrors: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly onNameChange: (value: string) => void;
  readonly onValueChange: (value: string) => void;
  readonly onSecretChange: (secret: boolean) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onClose: () => void;
}) {
  const notice =
    valueError === undefined && name.length > 0
      ? secretValueNotice(secret, value)
      : undefined;
  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="environment-variable-dialog"
        backdropClassName="environment-dialog-backdrop"
      >
        <DialogTitle>Add Secret or Env Var</DialogTitle>
        <form className="environment-dialog-form" onSubmit={onSubmit}>
          <div className="environment-dialog-fields">
            <div className="environment-dialog-field">
              <label htmlFor={`${fieldId}-name`}>Name</label>
              <Input
                id={`${fieldId}-name`}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={name}
                placeholder="MY_VAR"
                aria-invalid={nameError !== undefined}
                aria-describedby={
                  nameError === undefined ? undefined : `${fieldId}-name-error`
                }
                onChange={(event) => onNameChange(event.target.value)}
              />
              <FieldError id={`${fieldId}-name-error`}>{nameError}</FieldError>
            </div>
            <div className="environment-dialog-field">
              <label htmlFor={`${fieldId}-value`}>Value</label>
              <Textarea
                id={`${fieldId}-value`}
                rows={4}
                autoComplete={secret ? "new-password" : "off"}
                spellCheck={false}
                value={value}
                placeholder="Value"
                aria-invalid={valueError !== undefined}
                aria-describedby={
                  valueError === undefined
                    ? undefined
                    : `${fieldId}-value-error`
                }
                onChange={(event) => onValueChange(event.target.value)}
              />
              <FieldError id={`${fieldId}-value-error`}>
                {valueError}
              </FieldError>
              <ValueNotice id={`${fieldId}-value-notice`} notice={notice} />
            </div>
            <div className="environment-dialog-secret-option">
              <Checkbox checked={secret} onChange={onSecretChange}>
                Secret
              </Checkbox>
              <p>
                Secret values are hidden after saving and cannot be empty. Env
                var values stay visible here.
              </p>
            </div>
            {formErrors.map((error) => (
              <p key={error} className="environment-field-error" role="alert">
                {error}
              </p>
            ))}
          </div>
          <div className="environment-dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !name ||
                nameError !== undefined ||
                (secret && value.length === 0)
              }
            >
              {pending
                ? "Adding…"
                : notice?.tone === "warning"
                  ? "Add Anyway"
                  : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

const summaryNames = (names: ReadonlyArray<string>) =>
  names.length <= 3
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")}, +${names.length - 3} more`;

export function BulkAddEnvironmentVariablesDialog({
  open,
  fieldId,
  contents,
  autoDetect,
  replace,
  existingKinds,
  serverErrors,
  pending,
  onContentsChange,
  onAutoDetectChange,
  onReplaceChange,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  readonly fieldId: string;
  readonly contents: string;
  readonly autoDetect: boolean;
  readonly replace: boolean;
  /** Kinds already stored in this scope; replacing a secret keeps it secret. */
  readonly existingKinds: ReadonlyMap<string, EnvironmentVariableKind>;
  readonly serverErrors: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly onContentsChange: (value: string) => void;
  readonly onAutoDetectChange: (value: boolean) => void;
  readonly onReplaceChange: (value: boolean) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}) {
  const parsed = parseEnvironmentVariableAssignments(contents);
  const assignments = parsed.flatMap(({ line, name, value }) =>
    name === undefined || value === undefined
      ? []
      : [
          {
            line,
            name,
            value,
            secret:
              existingKinds.get(name) === "secret" ||
              (autoDetect && looksLikeSecretEnvironmentVariable(name, value)),
          },
        ],
  );
  const problems = [
    ...parsed.flatMap(({ line, error }) =>
      error === undefined ? [] : [{ line, error }],
    ),
    ...assignments.flatMap(({ line, value, secret }) =>
      secret && value.length === 0
        ? [{ line, error: EMPTY_SECRET_PROBLEM }]
        : [],
    ),
  ].sort((left, right) => left.line - right.line);
  const secrets = assignments.flatMap(({ name, secret }) =>
    secret ? [name] : [],
  );
  const weakSecrets = assignments.flatMap(({ name, value, secret }) =>
    secret && value.length > 0 && isWeakSecretValue(value) ? [name] : [],
  );
  const conflicts = assignments.flatMap(({ name }) =>
    existingKinds.has(name) ? [name] : [],
  );
  const tooMany = parsed.length > MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS;
  const canSubmit =
    !pending &&
    assignments.length > 0 &&
    problems.length === 0 &&
    !tooMany &&
    (conflicts.length === 0 || replace);
  const summary = `${plural(assignments.length, "assignment")} detected: ${plural(
    secrets.length,
    "secret",
  )}${secrets.length > 0 ? ` (${summaryNames(secrets)})` : ""} and ${plural(
    assignments.length - secrets.length,
    "env var",
  )}.`;
  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && onClose()}>
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
        <form
          className="environment-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }}
        >
          <div className="environment-dialog-fields">
            <div className="environment-dialog-field">
              <label htmlFor={`${fieldId}-bulk`}>Assignments</label>
              <Textarea
                id={`${fieldId}-bulk`}
                autoFocus
                rows={12}
                autoComplete="off"
                spellCheck={false}
                value={contents}
                placeholder={"API_KEY='secret-value'\nNODE_ENV=development"}
                aria-describedby={`${fieldId}-bulk-summary`}
                onChange={(event) => onContentsChange(event.target.value)}
              />
              <p id={`${fieldId}-bulk-summary`} aria-live="polite">
                {summary}
              </p>
              {problems.length > 0 || tooMany ? (
                <ul className="environment-bulk-problems">
                  {tooMany ? (
                    <li>
                      Add at most {MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS} values
                      at once.
                    </li>
                  ) : null}
                  {problems.map(({ line, error }) => (
                    <li key={line}>
                      Line {line}: {error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {weakSecrets.length > 0 ? (
              <p className="environment-field-warning">
                {summaryNames(weakSecrets)}:{" "}
                {weakSecrets.length === 1
                  ? "this value is"
                  : "these values are"}{" "}
                short or common. dx hides every occurrence of a secret in
                command output, so unrelated text would be hidden too.
              </p>
            ) : null}
            <Checkbox checked={autoDetect} onChange={onAutoDetectChange}>
              Auto-detect secrets
            </Checkbox>
            {conflicts.length > 0 ? (
              <Checkbox checked={replace} onChange={onReplaceChange}>
                Replace {plural(conflicts.length, "existing value")} (
                {summaryNames(conflicts)})
              </Checkbox>
            ) : null}
            {serverErrors.map((error) => (
              <p key={error} className="environment-field-error" role="alert">
                {error}
              </p>
            ))}
          </div>
          <div className="environment-dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {pending
                ? "Adding…"
                : weakSecrets.length > 0
                  ? "Add All Anyway"
                  : "Add All"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

export function EnvironmentVariableValues({
  actions,
  filter,
  onFilterChange,
  loading,
  loadError,
  items,
  managed,
  updatedBy,
  pendingIds,
  canMutate,
  onReload,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly actions?: ReactNode;
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly items: ReadonlyArray<EnvironmentVariableData>;
  /** Values another settings page sets, shown read-only. */
  readonly managed: ReadonlyArray<{
    readonly name: string;
    readonly detail: string;
  }>;
  /** Who last changed each value, from the loaded history. */
  readonly updatedBy: ReadonlyMap<string, string>;
  readonly pendingIds: ReadonlySet<string>;
  readonly canMutate: boolean;
  readonly onReload: () => void;
  readonly onEdit: (
    item: EnvironmentVariableData,
    trigger: HTMLElement,
  ) => void;
  readonly onToggle: (item: EnvironmentVariableData) => void;
  readonly onDelete: (
    item: EnvironmentVariableData,
    trigger: HTMLElement,
  ) => void;
}) {
  const query = filter.trim().toUpperCase();
  const visible =
    query === "" ? items : items.filter(({ name }) => name.includes(query));
  const visibleManaged =
    query === "" ? managed : managed.filter(({ name }) => name.includes(query));
  return (
    <SettingsCard
      title="Values"
      className="environment-values-card"
      actions={
        <div className="environment-card-actions">
          <div className="environment-filter">
            <Input
              type="search"
              aria-label="Filter by name"
              placeholder="Filter by name..."
              value={filter}
              onChange={(event) => onFilterChange(event.target.value)}
            />
            <Search aria-hidden="true" />
          </div>
          {actions}
        </div>
      }
    >
      {loading ? (
        <div className="environment-card-state">
          <DxLoading label="Loading values…" />
        </div>
      ) : loadError ? (
        <div className="environment-card-state" role="alert">
          {loadError}
          <Button size="xs" variant="outline" onClick={onReload}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 && managed.length === 0 ? (
        <p className="settings-card-empty environment-card-state">
          No secrets or environment variables yet.
        </p>
      ) : visible.length === 0 && visibleManaged.length === 0 ? (
        <p className="settings-card-empty environment-card-state">
          No values match “{filter.trim()}”.
        </p>
      ) : (
        <table className="environment-values" aria-label="Values">
          <thead>
            <tr className="environment-values-row">
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              <th scope="col">Last Updated</th>
              <th scope="col" className="environment-values-menu">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              const pending = pendingIds.has(item.reference.id);
              const actor = updatedBy.get(item.reference.id);
              return (
                <tr
                  key={item.reference.id}
                  className="environment-values-row"
                  aria-busy={pending}
                  data-disabled={item.enabled ? undefined : ""}
                >
                  <td className="environment-values-cell environment-values-name">
                    <code>{item.name}</code>
                    {pending ? (
                      <span className="environment-values-hint">Saving…</span>
                    ) : isReservedEnvironmentVariableName(item.name) ? (
                      <span
                        className="environment-values-hint"
                        title={`${item.name} is set by dx in Orbs, so this value is not applied.`}
                      >
                        Not applied: set by dx
                      </span>
                    ) : item.enabled ? null : (
                      <span className="environment-values-hint">Disabled</span>
                    )}
                  </td>
                  <td className="environment-values-cell environment-values-value">
                    {item.kind === "variable" && item.value === "" ? (
                      <span className="environment-values-hint">Empty</span>
                    ) : (
                      <code
                        title={item.kind === "secret" ? undefined : item.value}
                      >
                        {item.kind === "secret" ? "••••••••" : item.value}
                      </code>
                    )}
                  </td>
                  <td className="environment-values-cell environment-values-updated">
                    <TimeText text={relativeTime(item.updatedAt)} />
                    {actor === undefined ? null : ` by ${actor}`}
                  </td>
                  <td className="environment-values-cell environment-values-menu">
                    {canMutate ? (
                      <EnvironmentVariableMenu
                        item={item}
                        disabled={pending}
                        onEdit={onEdit}
                        onToggle={onToggle}
                        onDelete={onDelete}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {visibleManaged.map(({ name, detail }) => (
              <tr key={name} className="environment-values-row">
                <td className="environment-values-cell environment-values-name">
                  <code>{name}</code>
                </td>
                <td className="environment-values-cell environment-values-value">
                  <Link
                    to="/settings/$section"
                    params={{ section: "model-routing" }}
                    state={(previous) => previous}
                    className="environment-values-link"
                  >
                    Configured in Model Routing
                    <ArrowUpRight aria-hidden="true" />
                  </Link>
                </td>
                <td className="environment-values-cell environment-values-updated">
                  {detail}
                </td>
                <td className="environment-values-cell environment-values-menu" />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsCard>
  );
}

function EnvironmentVariableMenu({
  item,
  disabled,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly item: EnvironmentVariableData;
  readonly disabled: boolean;
  readonly onEdit: (
    item: EnvironmentVariableData,
    trigger: HTMLElement,
  ) => void;
  readonly onToggle: (item: EnvironmentVariableData) => void;
  readonly onDelete: (
    item: EnvironmentVariableData,
    trigger: HTMLElement,
  ) => void;
}) {
  // Dialogs opened from the menu return focus to this row's trigger.
  const trigger = useRef<HTMLButtonElement>(null);
  const returnTo = () => trigger.current ?? document.body;
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        render={
          <Button
            ref={trigger}
            size="icon-xs"
            variant="ghost"
            aria-label={`Manage ${item.name}`}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup">
            <Menu.Item
              className="thread-menu-item"
              onClick={() => onEdit(item, returnTo())}
            >
              {item.kind === "secret" ? "Rotate" : "Edit"}
            </Menu.Item>
            <Menu.Item
              className="thread-menu-item"
              onClick={() => onToggle(item)}
            >
              {item.enabled ? "Disable" : "Enable"}
            </Menu.Item>
            <Menu.Item
              className="thread-menu-item environment-menu-danger"
              onClick={() => onDelete(item, returnTo())}
            >
              Delete
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const historyActions = {
  create: "Created",
  update: "Updated",
  rotate: "Changed",
  delete: "Deleted",
} as const;

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
    <SettingsCard title="History" className="environment-history-card">
      {loading ? (
        <div className="environment-card-state">
          <DxLoading label="Loading history…" />
        </div>
      ) : loadError ? (
        <div className="environment-card-state" role="alert">
          {loadError}
          <Button size="xs" variant="outline" onClick={onReload}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="settings-card-empty environment-card-state">
          No changes yet.
        </p>
      ) : (
        <>
          <ul className="environment-history">
            {items.map((item) => (
              <li key={item.id}>
                <span>
                  {historyActions[item.action]} <code>{item.name}</code>
                </span>
                <span className="environment-history-meta">
                  {item.actorName} ·{" "}
                  <TimeText text={relativeTime(item.occurredAt)} />
                </span>
              </li>
            ))}
          </ul>
          {moreError === undefined ? null : (
            <p className="environment-field-error" role="alert">
              {moreError}
            </p>
          )}
          {hasMore ? (
            <div className="environment-history-more">
              {loadingMore ? (
                <DxLoading label="Loading older changes…" />
              ) : (
                <Button size="xs" variant="outline" onClick={onLoadMore}>
                  Load older changes
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}

export function EditEnvironmentVariableDialog({
  fieldId,
  item,
  value,
  error,
  pending,
  finalFocus,
  onValueChange,
  onClose,
  onSubmit,
}: {
  readonly fieldId: string;
  readonly item?: EnvironmentVariableData;
  readonly value: string;
  readonly error?: string;
  readonly pending: boolean;
  readonly finalFocus: RefObject<HTMLElement | null>;
  readonly onValueChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}) {
  const verb = item?.kind === "secret" ? "Rotate" : "Edit";
  return (
    <DialogRoot
      open={item !== undefined}
      onOpenChange={(next) => !next && onClose()}
    >
      {item ? (
        <DialogContent
          className="environment-variable-dialog"
          backdropClassName="environment-dialog-backdrop"
          finalFocus={finalFocus}
        >
          <div className="environment-dialog-heading">
            <DialogTitle>
              {verb} {item.name}
            </DialogTitle>
            <DialogDescription>
              {item.kind === "secret"
                ? "Enter a new value. The current one stays hidden."
                : "New commands get the new value."}
            </DialogDescription>
          </div>
          <form
            className="environment-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <div className="environment-dialog-fields">
              <div className="environment-dialog-field">
                <label htmlFor={`${fieldId}-rotate`}>Value</label>
                <Textarea
                  id={`${fieldId}-rotate`}
                  autoFocus
                  rows={4}
                  autoComplete={item.kind === "secret" ? "new-password" : "off"}
                  spellCheck={false}
                  value={value}
                  placeholder={item.kind === "secret" ? "New value" : "Value"}
                  aria-invalid={error !== undefined}
                  onChange={(event) => onValueChange(event.target.value)}
                />
                <FieldError id={`${fieldId}-rotate-error`}>{error}</FieldError>
                {error === undefined ? (
                  <ValueNotice
                    id={`${fieldId}-rotate-notice`}
                    notice={secretValueNotice(item.kind === "secret", value)}
                  />
                ) : null}
              </div>
            </div>
            <div className="environment-dialog-actions">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  pending || (item.kind === "secret" && value.length === 0)
                }
              >
                {pending
                  ? "Saving…"
                  : secretValueNotice(item.kind === "secret", value)?.tone ===
                      "warning"
                    ? "Save Anyway"
                    : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

export function DeleteEnvironmentVariableDialog({
  item,
  error,
  pending,
  finalFocus,
  onClose,
  onConfirm,
}: {
  readonly item?: EnvironmentVariableData;
  readonly error?: string;
  readonly pending: boolean;
  readonly finalFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogRoot
      open={item !== undefined}
      onOpenChange={(next) => !next && onClose()}
    >
      {item ? (
        <DialogContent
          className="environment-variable-dialog"
          backdropClassName="environment-dialog-backdrop"
          finalFocus={finalFocus}
        >
          <div className="environment-dialog-heading">
            <DialogTitle>Delete {item.name}?</DialogTitle>
            <DialogDescription>
              New commands stop getting it. Running processes keep the
              environment they started with.
            </DialogDescription>
          </div>
          {error === undefined ? null : (
            <p className="environment-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="environment-dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

export function AddEnvironmentVariableActions({
  onBulkAdd,
  onAdd,
}: {
  readonly onBulkAdd: () => void;
  readonly onAdd: () => void;
}) {
  return (
    <>
      <Button size="xs" variant="ghost" onClick={onBulkAdd}>
        Bulk Add
      </Button>
      <Button size="xs" onClick={onAdd}>
        <Plus aria-hidden="true" />
        Add
      </Button>
    </>
  );
}
