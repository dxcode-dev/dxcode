import { Check, CircleAlert, Mail, MailCheck, Ticket } from "lucide-react";
import type * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { GitHubIcon } from "../../shared/ui/github-icon.js";
import { GoogleIcon } from "../../shared/ui/google-icon.js";
import { Input } from "../../shared/ui/input.js";
import { AuthLayout, AuthNotice } from "./auth-layout.js";
import { AuthShowcase } from "./auth-showcase.js";

export type AuthProvider = "google" | "github";

const providerLabel: Record<AuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};

/** One outline button per redirect provider, in the order given. */
export function AuthProviderButtons({
  providers,
  opening,
  disabled,
  onSelect,
}: {
  readonly providers: readonly AuthProvider[];
  /** The provider whose redirect is starting. */
  readonly opening?: AuthProvider;
  readonly disabled: boolean;
  readonly onSelect: (provider: AuthProvider) => void;
}) {
  return (
    <div className="auth-providers">
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          size="lg"
          block
          className="auth-provider"
          disabled={disabled}
          busy={opening === provider}
          onClick={() => onSelect(provider)}
        >
          {provider === "google" ? <GoogleIcon /> : <GitHubIcon />}
          {opening === provider
            ? `Opening ${providerLabel[provider]}…`
            : `Continue with ${providerLabel[provider]}`}
        </Button>
      ))}
    </div>
  );
}

export function AuthDivider() {
  return (
    <div className="auth-divider" aria-hidden="true">
      <span>or</span>
    </div>
  );
}

export type AuthEmailMethod = "link" | "password";

const domainHint = (domains: readonly string[]) =>
  domains.length === 0
    ? undefined
    : domains.length === 1
      ? `Use your @${domains[0]} email.`
      : `Use an email at ${domains.slice(0, -1).join(", ")} or ${domains.at(-1)}.`;

const submitLabel = (
  method: AuthEmailMethod,
  creating: boolean,
  waitlist: boolean,
  pending: boolean,
) =>
  method === "link"
    ? pending
      ? "Sending…"
      : waitlist
        ? "Join the waitlist"
        : "Continue with email"
    : creating
      ? pending
        ? "Creating account…"
        : "Create account"
      : pending
        ? "Signing in…"
        : "Sign in";

const switchLabel = (withPassword: boolean, creating: boolean) =>
  withPassword
    ? "Email me a sign-in link instead"
    : creating
      ? "Create an account with a password"
      : "Sign in with a password";

/** The email field, its allowed-domain hint, and the error it carries. */
function EmailField({
  allowedEmailDomains,
  defaultEmail,
  autoFocus,
  pending,
  invalid,
}: {
  readonly allowedEmailDomains: readonly string[];
  readonly defaultEmail?: string;
  readonly autoFocus: boolean;
  readonly pending: boolean;
  /** The request failed; the alert `sign-in-error` says why. */
  readonly invalid: boolean;
}) {
  const hint = domainHint(allowedEmailDomains);
  const describedBy = invalid
    ? "sign-in-error"
    : hint === undefined
      ? undefined
      : "sign-in-email-hint";
  return (
    <div className="auth-field">
      <label htmlFor="sign-in-email">Email</label>
      <Input
        id="sign-in-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        autoFocus={autoFocus}
        defaultValue={defaultEmail}
        readOnly={pending}
        placeholder={
          allowedEmailDomains.length === 1
            ? `you@${allowedEmailDomains[0]}`
            : "you@company.com"
        }
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      {hint === undefined ? null : (
        <p id="sign-in-email-hint" className="auth-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Email first. A magic link when the deployment offers one, otherwise a
 * password; with both, a quiet link switches between them. A failed request
 * shows its error above the button and marks the email field invalid.
 */
export function AuthEmailForm({
  method,
  creating,
  allowedEmailDomains,
  pending,
  disabled = false,
  waitlist = false,
  error,
  canSwitchMethod,
  onMethodChange,
  onSubmit,
  defaultEmail,
  autoFocus = true,
}: {
  readonly method: AuthEmailMethod;
  /** The password method creates an account instead of signing in. */
  readonly creating: boolean;
  readonly allowedEmailDomains: readonly string[];
  readonly pending: boolean;
  /** Another way in is under way, such as a Google redirect. */
  readonly disabled?: boolean;
  /** A new address joins the waitlist rather than getting an account. */
  readonly waitlist?: boolean;
  readonly error?: string;
  readonly canSwitchMethod: boolean;
  readonly onMethodChange: (method: AuthEmailMethod) => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  readonly defaultEmail?: string;
  readonly autoFocus?: boolean;
}) {
  const withPassword = method === "password";
  const naming = creating && withPassword;
  return (
    <form
      className="auth-form sign-in-form"
      onSubmit={onSubmit}
      aria-busy={pending}
    >
      {naming ? (
        <div className="auth-field">
          <label htmlFor="sign-in-name">Name</label>
          <Input
            id="sign-in-name"
            name="name"
            autoComplete="name"
            required
            maxLength={128}
            placeholder="Ada Lovelace"
            readOnly={pending}
          />
        </div>
      ) : null}
      <EmailField
        allowedEmailDomains={allowedEmailDomains}
        defaultEmail={defaultEmail}
        autoFocus={autoFocus}
        pending={pending}
        invalid={error !== undefined}
      />
      {withPassword ? (
        <div className="auth-field">
          <label htmlFor="sign-in-password">Password</label>
          <Input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete={creating ? "new-password" : "current-password"}
            minLength={8}
            maxLength={128}
            required
            readOnly={pending}
            placeholder={creating ? "At least 8 characters" : undefined}
          />
        </div>
      ) : null}
      {error === undefined ? null : (
        <AuthAlert id="sign-in-error">{error}</AuthAlert>
      )}
      <Button
        type="submit"
        size="lg"
        block
        className="auth-submit"
        busy={pending}
        disabled={disabled}
        aria-disabled={pending || undefined}
      >
        {submitLabel(method, creating, waitlist, pending)}
      </Button>
      {canSwitchMethod ? (
        <button
          type="button"
          className="auth-link auth-method-switch"
          onClick={() => onMethodChange(withPassword ? "link" : "password")}
        >
          {switchLabel(withPassword, creating)}
        </button>
      ) : null}
    </form>
  );
}

/** A request or redirect that failed. */
export function AuthAlert({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <p id={id} className="auth-alert" role="alert">
      <CircleAlert aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** "New to dx? Create an account": moves between sign-in and sign-up. */
export function AuthSwitch({
  prompt,
  children,
}: {
  readonly prompt: string;
  /** The link or button that switches. */
  readonly children: React.ReactNode;
}) {
  return (
    <p className="auth-switch">
      {prompt} {children}
    </p>
  );
}

/** The agreement line under a sign-up form. */
export function AuthTerms({
  termsUrl,
  privacyUrl,
}: {
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
}) {
  if (termsUrl === undefined && privacyUrl === undefined) return null;
  return (
    <p className="auth-terms">
      By continuing, you agree to the{" "}
      {termsUrl === undefined ? null : <a href={termsUrl}>Terms of Service</a>}
      {termsUrl !== undefined && privacyUrl !== undefined ? " and " : null}
      {privacyUrl === undefined ? null : (
        <a href={privacyUrl}>Privacy Policy</a>
      )}
      .
    </p>
  );
}

/** Terms and Privacy at the foot of a sign-in page. */
export function AuthLegalLinks({
  termsUrl,
  privacyUrl,
}: {
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
}) {
  if (termsUrl === undefined && privacyUrl === undefined) return null;
  return (
    <nav className="auth-legal" aria-label="Legal">
      {termsUrl === undefined ? null : <a href={termsUrl}>Terms of Service</a>}
      {privacyUrl === undefined ? null : (
        <a href={privacyUrl}>Privacy Policy</a>
      )}
    </nav>
  );
}

/**
 * The waitlist step: the address is on the list, what happens next, and the
 * way to skip it. A Google redirect carries only the outcome, not the email.
 */
export function AuthWaitlisted({
  email,
  stepKey,
  onBack,
}: {
  readonly email?: string;
  readonly stepKey?: string;
  readonly onBack: () => void;
}) {
  return (
    <AuthLayout
      screen="waitlisted"
      title="You're on the waitlist"
      icon={<Check />}
      tone="success"
      stepKey={stepKey}
      aside={<AuthShowcase />}
    >
      <AuthNotice
        actions={
          <button type="button" className="auth-link" onClick={onBack}>
            {email === undefined ? "Back to sign in" : "Use a different email"}
          </button>
        }
      >
        <p>
          {email === undefined ? (
            "Thanks for your interest in dx. We'll email you when your account is ready."
          ) : (
            <>
              Thanks for your interest in dx. We'll email{" "}
              <strong>{email}</strong> when your account is ready.
            </>
          )}
        </p>
      </AuthNotice>
      <ol className="auth-steps">
        <li data-done="">
          <span className="auth-steps-mark" aria-hidden="true">
            <Check />
          </span>
          <span>
            <strong>You're on the list</strong>
            {email === undefined ? null : <> as {email}</>}
          </span>
        </li>
        <li>
          <span className="auth-steps-mark" aria-hidden="true">
            2
          </span>
          <span>
            <strong>We email your invite</strong> when your account is ready
          </span>
        </li>
        <li>
          <span className="auth-steps-mark" aria-hidden="true">
            3
          </span>
          <span>
            <strong>Open it and sign in</strong> with the same email
          </span>
        </li>
      </ol>
      <p className="auth-skip">
        <Ticket aria-hidden="true" />
        <span>Have a workspace invite link? Open it to skip the line.</span>
      </p>
    </AuthLayout>
  );
}

/** A sign-in link is on its way: where, how long it lasts, and a resend. */
export function AuthCheckEmail({
  email,
  stepKey,
  resend,
  resendError,
  onResend,
  onBack,
  children,
}: {
  readonly email: string;
  readonly stepKey?: string;
  readonly resend: "idle" | "sending" | "sent";
  readonly resendError?: string;
  readonly onResend: () => void;
  readonly onBack: () => void;
  /** The Turnstile challenge slot a resend may need. */
  readonly children?: React.ReactNode;
}) {
  return (
    <AuthLayout
      aside={<AuthShowcase />}
      screen="check-email"
      title="Check your email"
      icon={<Mail />}
      tone="success"
      stepKey={stepKey}
    >
      <AuthNotice
        actions={
          <>
            {resendError === undefined ? null : (
              <AuthAlert>{resendError}</AuthAlert>
            )}
            <Button
              type="button"
              variant="outline"
              size="lg"
              block
              className="auth-provider"
              busy={resend === "sending"}
              disabled={resend === "sent"}
              onClick={onResend}
            >
              {resend === "sending"
                ? "Sending…"
                : resend === "sent"
                  ? "Sent again"
                  : "Resend link"}
            </Button>
            <button type="button" className="auth-link" onClick={onBack}>
              Use a different email
            </button>
          </>
        }
      >
        <p>
          We sent a sign-in link to <strong>{email}</strong>.
        </p>
        <p>It works once and expires in 10 minutes.</p>
      </AuthNotice>
      {children}
    </AuthLayout>
  );
}

/** A password sign-up waits on its confirmation email. */
export function AuthConfirmEmail({
  email,
  stepKey,
  onBack,
}: {
  readonly email: string;
  readonly stepKey?: string;
  readonly onBack: () => void;
}) {
  return (
    <AuthLayout
      aside={<AuthShowcase />}
      screen="verify-email"
      title="Confirm your email"
      icon={<MailCheck />}
      tone="success"
      stepKey={stepKey}
    >
      <AuthNotice
        actions={
          <button type="button" className="auth-link" onClick={onBack}>
            Use a different email
          </button>
        }
      >
        <p>
          We sent a confirmation link to <strong>{email}</strong>. Open it to
          finish creating your account.
        </p>
        <p>
          The link expires in 1 hour. If this email already has a dx account, we
          sent a sign-in reminder instead.
        </p>
      </AuthNotice>
    </AuthLayout>
  );
}
