import type * as React from "react";
import { cn } from "../utils.js";
import "./display.css";

/**
 * What a list or panel shows when it has nothing, is loading, or failed:
 * an optional icon, one line on what is (not) here, an optional detail, and
 * an optional action. `tone="error"` colors it as a failure.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone,
  busy,
  role,
  className,
}: {
  readonly icon?: React.ReactNode;
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly action?: React.ReactNode;
  readonly tone?: "error";
  /** Marks a loading state for assistive tech; it shows a spinner-free hint. */
  readonly busy?: boolean;
  /** `status` announces changes politely; errors use `alert` on their own. */
  readonly role?: "status" | "alert";
  readonly className?: string;
}) {
  return (
    <div
      className={cn("dx-empty", className)}
      data-tone={tone}
      role={role ?? (tone === "error" ? "alert" : undefined)}
      aria-busy={busy || undefined}
    >
      {icon === undefined ? null : (
        <span className="dx-empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="dx-empty-title">{title}</p>
      {description === undefined ? null : (
        <p className="dx-empty-description">{description}</p>
      )}
      {action}
    </div>
  );
}
