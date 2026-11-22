import type * as React from "react";
import { cn } from "../utils.js";
import { Badge } from "./badge.js";
import "./requirement-list.css";

/**
 * A short list of what must be allowed or set up before something works,
 * such as the macOS permissions a Mac's Desktop needs. Holds
 * `RequirementRow`s.
 */
export function RequirementList({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return <ul className={cn("dx-requirements", className)} {...props} />;
}

/**
 * One requirement: an icon, its name with whether it is met (a badge), one
 * muted line on what it is for, and, while it is not met, the action that
 * meets it. `note` answers that action quietly below the row: what happened
 * (`tone` info) or why it could not (`tone` error).
 */
export function RequirementRow({
  icon,
  label,
  description,
  met,
  metLabel = "Allowed",
  neededLabel = "Needed",
  action,
  note,
  noteTone = "info",
  className,
}: {
  readonly icon?: React.ReactNode;
  readonly label: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly met: boolean;
  /** The badge when met. */
  readonly metLabel?: string;
  /** The badge when not met. */
  readonly neededLabel?: string;
  /** Shown only while the requirement is not met. */
  readonly action?: React.ReactNode;
  readonly note?: React.ReactNode;
  readonly noteTone?: "info" | "error";
  readonly className?: string;
}) {
  return (
    <li className={cn("dx-requirement", className)} data-met={met || undefined}>
      {icon === undefined ? null : (
        <span className="dx-requirement-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="dx-requirement-copy">
        <span className="dx-requirement-label">
          <span>{label}</span>
          <Badge tone={met ? "success" : "warning"}>
            {met ? metLabel : neededLabel}
          </Badge>
        </span>
        {description === undefined ? null : (
          <span className="dx-requirement-description">{description}</span>
        )}
      </span>
      {met || action === undefined ? null : (
        <span className="dx-requirement-action">{action}</span>
      )}
      {note === undefined || note === null ? null : (
        <p
          className="dx-requirement-note"
          data-tone={noteTone}
          role={noteTone === "error" ? "alert" : "status"}
        >
          {note}
        </p>
      )}
    </li>
  );
}
