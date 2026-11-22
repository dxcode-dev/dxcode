import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import "./notice.css";

export type NoticeTone = "info" | "warning" | "danger";

const ICON: Readonly<Record<NoticeTone, React.ComponentType>> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
};

/**
 * Something the person should know before they go on: their credit ran out,
 * a key expires, a setting is decided elsewhere. A title, an optional line
 * on what it means or what to do, and optional actions. `layout="inline"`
 * sits in a page or card; `layout="bar"` spans the app above its panels.
 * `onDismiss` adds a close button. `danger` is announced as an alert,
 * the others politely.
 */
export function Notice({
  tone = "info",
  layout = "inline",
  title,
  description,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
}: {
  readonly tone?: NoticeTone;
  readonly layout?: "inline" | "bar";
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly className?: string;
}) {
  const Icon = ICON[tone];
  return (
    <section
      className={cn("dx-notice", className)}
      data-tone={tone}
      data-layout={layout}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="dx-notice-icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="dx-notice-copy">
        <p className="dx-notice-title">{title}</p>
        {description === undefined ? null : (
          <p className="dx-notice-description">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="dx-notice-actions">{actions}</div>
      )}
      {onDismiss === undefined ? null : (
        <Button
          type="button"
          variant="subtle"
          size="icon-xs"
          className="dx-notice-dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </section>
  );
}
