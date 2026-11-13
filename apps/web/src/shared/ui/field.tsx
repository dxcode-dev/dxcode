import type * as React from "react";
import { cn } from "../utils.js";
import "./form-controls.css";

/**
 * A labelled form control: its label, the control, then a hint or, when it
 * failed, the error in its place. Give the control the `id` passed here.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  readonly id?: string;
  readonly label: React.ReactNode;
  readonly hint?: React.ReactNode;
  readonly error?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn("dx-field", className)}
      data-invalid={error ? "" : undefined}
    >
      <label className="dx-field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="dx-field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="dx-field-hint">{hint}</p>
      ) : null}
    </div>
  );
}
