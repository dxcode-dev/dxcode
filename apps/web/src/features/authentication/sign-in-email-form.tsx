import type * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import { SignInField } from "./sign-in-field.js";

export type EmailMethod = "link" | "password";

const domainHint = (domains: readonly string[]) =>
  domains.length === 0
    ? undefined
    : domains.length === 1
      ? `Use your @${domains[0]} email.`
      : `Use an email at ${domains.slice(0, -1).join(", ")} or ${domains.at(-1)}.`;

/**
 * Email first: a magic link when offered, otherwise a password. With both,
 * one link switches between them.
 */
export function SignInEmailForm({
  method,
  onMethodChange,
  canSwitchMethod,
  passwordSignUp,
  allowedEmailDomains,
  pending,
  errorId,
  onSubmit,
}: {
  readonly method: EmailMethod;
  readonly onMethodChange: (method: EmailMethod) => void;
  readonly canSwitchMethod: boolean;
  /** The password method creates an account instead of signing in. */
  readonly passwordSignUp: boolean;
  readonly allowedEmailDomains: readonly string[];
  readonly pending: boolean;
  /** The id of the visible error, which describes the email field. */
  readonly errorId: string | undefined;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const creating = passwordSignUp && method === "password";
  return (
    <form className="sign-in-form" onSubmit={onSubmit}>
      {creating ? (
        <SignInField label="Name" htmlFor="sign-in-name">
          <Input
            id="sign-in-name"
            name="name"
            autoComplete="name"
            required
            maxLength={128}
            placeholder="Your name"
          />
        </SignInField>
      ) : null}
      <SignInField
        label="Email"
        htmlFor="sign-in-email"
        hint={domainHint(allowedEmailDomains)}
      >
        <Input
          id="sign-in-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder={
            allowedEmailDomains.length === 1
              ? `you@${allowedEmailDomains[0]}`
              : "you@example.com"
          }
          aria-invalid={errorId === undefined ? undefined : true}
          aria-describedby={errorId}
        />
      </SignInField>
      {method === "password" ? (
        <SignInField label="Password" htmlFor="sign-in-password">
          <Input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete={creating ? "new-password" : "current-password"}
            minLength={8}
            maxLength={128}
            required
            placeholder={creating ? "At least 8 characters" : undefined}
          />
        </SignInField>
      ) : null}
      <Button type="submit" className="sign-in-primary" disabled={pending}>
        {pending
          ? "Please wait…"
          : method === "link"
            ? "Continue with email"
            : creating
              ? "Create account"
              : "Sign in"}
      </Button>
      {canSwitchMethod ? (
        <button
          type="button"
          className="sign-in-switch"
          onClick={() =>
            onMethodChange(method === "link" ? "password" : "link")
          }
        >
          {method === "password"
            ? "Email me a sign-in link instead"
            : passwordSignUp
              ? "Create an account with a password"
              : "Sign in with a password"}
        </button>
      ) : null}
    </form>
  );
}
