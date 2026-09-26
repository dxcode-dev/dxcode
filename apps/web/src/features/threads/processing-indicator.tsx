import type * as React from "react";

export function ProcessingIndicator({
  label,
  accessibleLabel,
  className,
}: {
  readonly label?: React.ReactNode;
  readonly accessibleLabel: string;
  readonly className?: string;
}) {
  return (
    <span
      className={`processing-indicator${className === undefined ? "" : ` ${className}`}`}
      role="status"
      aria-label={accessibleLabel}
    >
      <span className="processing-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
