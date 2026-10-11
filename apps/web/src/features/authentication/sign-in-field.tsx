import type * as React from "react";

/** A labelled sign-in input with an optional hint below it. */
export function SignInField({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="sign-in-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint === undefined ? null : <p className="sign-in-hint">{hint}</p>}
    </div>
  );
}
