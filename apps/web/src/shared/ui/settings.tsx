import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import { Select, type SelectOption } from "./select.js";
import { Switch } from "./switch.js";

/**
 * The one settings page heading: a compact title row, an optional muted
 * detail inside the title, actions or status on the right, and an intro.
 */
export function SettingsHeading({
  title,
  detail,
  description,
  actions,
}: {
  readonly title: string;
  readonly detail?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="settings-heading">
      <div className="settings-heading-row">
        <h1>
          {title}
          {detail === undefined ? null : <span>{detail}</span>}
        </h1>
        {actions}
      </div>
      {description === undefined ? null : <p>{description}</p>}
    </header>
  );
}

export function SettingsBackgroundError({
  children,
  onRetry,
}: {
  readonly children: ReactNode;
  readonly onRetry: () => void;
}) {
  return (
    <div className="settings-background-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <span>{children}</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function SettingsCard({
  title,
  actions,
  description,
  variant = "surface",
  className,
  children,
}: {
  readonly title?: string;
  readonly actions?: ReactNode;
  readonly description?: ReactNode;
  readonly variant?: "surface" | "outline";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("settings-card", className)} data-variant={variant}>
      {title === undefined ? null : (
        <header className="settings-card-header">
          <div className="settings-card-header-copy">
            <h2>{title}</h2>
            {description === undefined ? null : <p>{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  badge,
  control,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly badge?: ReactNode;
  readonly control?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">
          <strong>{title}</strong>
          {badge === undefined ? null : <span>{badge}</span>}
        </div>
        {description === undefined ? null : typeof description === "string" ? (
          <p>{description}</p>
        ) : (
          <div className="settings-row-description">{description}</div>
        )}
      </div>
      {control === undefined ? null : (
        <div className="settings-row-control">{control}</div>
      )}
    </div>
  );
}

/** A setting's on/off switch; see `Switch`. */
export const SettingsToggle = Switch;

export type SettingsSelectOption = SelectOption;

/** A setting's choice list; see `Select`. */
export function SettingsSelect({
  id,
  value,
  onValueChange,
  options,
  label,
  disabled = false,
}: {
  readonly id?: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: ReadonlyArray<SettingsSelectOption>;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  return (
    <Select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      options={options}
      onValueChange={onValueChange}
    />
  );
}

export function SettingsFormActions({
  dirty,
  saving,
  message,
  error,
  form,
  resetLabel = "Reset",
  saveLabel = "Save",
  showStatus = true,
  showReset = true,
  onSave,
  onReset,
}: {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly message?: string;
  readonly error?: string;
  readonly form?: string;
  readonly resetLabel?: string;
  readonly saveLabel?: string;
  readonly showStatus?: boolean;
  readonly showReset?: boolean;
  readonly onSave: () => void;
  readonly onReset: () => void;
}) {
  return (
    <footer className="settings-form-actions" aria-live="polite">
      {showStatus || error !== undefined ? (
        <span
          className={error === undefined ? undefined : "settings-form-error"}
        >
          {error ?? message ?? (dirty ? "Unsaved changes" : "No changes")}
        </span>
      ) : null}
      {showReset ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={onReset}
        >
          {resetLabel}
        </Button>
      ) : null}
      <Button
        size="xs"
        disabled={!dirty || saving}
        type={form === undefined ? "button" : "submit"}
        form={form}
        onClick={form === undefined ? onSave : undefined}
      >
        {saving ? "Saving…" : saveLabel}
      </Button>
    </footer>
  );
}
