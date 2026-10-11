import type { SignInOptionsResponse } from "@dx/api";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import { Button } from "../../shared/ui/button.js";
import { GoogleIcon } from "../../shared/ui/google-icon.js";
import { WaitlistDialog } from "../../shared/ui/waitlist-dialog.js";
import { CheckEmailPanel } from "./check-email-panel.js";
import { type EmailMethod, SignInEmailForm } from "./sign-in-email-form.js";
import { signInErrorCode, signInErrorMessage } from "./sign-in-errors.js";
import {
  useGoogleSignIn,
  useMagicLinkRequest,
  usePasswordSignIn,
  usePasswordSignUp,
} from "./sign-in-mutations.js";
import { signInHref } from "./sign-in-paths.js";
import "./sign-in.css";

export type SignInPageMode = "sign-in" | "sign-up";

export interface SignInPageProps {
  readonly mode: SignInPageMode;
  readonly options: SignInOptionsResponse;
  /** Same-origin path to open after signing in. */
  readonly next: string | undefined;
  /** The `error` a provider redirect carried back, if any. */
  readonly redirectError: string | undefined;
  readonly onDismissRedirectError: () => void;
  /** Present on `/join/<token>`: the invite admits a new account. */
  readonly invite?: { readonly path: string; readonly workspace: string };
}

/** The signed-out entry point shared by every deployment: configured providers only. */
export function SignInPage({
  mode,
  options,
  next,
  redirectError,
  onDismissRedirectError,
  invite,
}: SignInPageProps) {
  const providers = new Set(options.providers);
  const hasLink = providers.has("magic-link");
  const hasPassword = providers.has("email-password");
  const hasGoogle = providers.has("google");
  const signUpAllowed = options.admission !== "invite" || invite !== undefined;
  // An invite page has one URL for both: new people create an account,
  // existing ones sign in.
  const [inviteMode, setInviteMode] = React.useState<SignInPageMode>("sign-up");
  const pageMode = invite === undefined ? mode : inviteMode;
  const showPasswordSignUp =
    pageMode === "sign-up" && hasPassword && signUpAllowed;

  const [method, setMethod] = React.useState<EmailMethod>(
    hasLink ? "link" : "password",
  );
  const challenge = React.useRef<HTMLDivElement>(null);
  const magicLink = useMagicLinkRequest();
  const resendLink = useMagicLinkRequest();
  const passwordSignIn = usePasswordSignIn();
  const passwordSignUp = usePasswordSignUp();
  const google = useGoogleSignIn();

  // Where provider redirects land: success opens the destination (an invite
  // must stay the callback so it can admit the account); failure comes back
  // here with `?error=`.
  const returnPage = invite?.path ?? signInHref("/signin", next);
  const successURL = invite?.path ?? next ?? "/";
  const pending =
    magicLink.isPending ||
    passwordSignIn.isPending ||
    passwordSignUp.isPending ||
    google.isPending;

  const resetRequests = () => {
    magicLink.reset();
    resendLink.reset();
    passwordSignIn.reset();
    passwordSignUp.reset();
    google.reset();
  };

  const requestError =
    magicLink.error ??
    passwordSignIn.error ??
    passwordSignUp.error ??
    google.error;
  const waitlistedEmail =
    magicLink.data?.outcome === "waitlisted"
      ? magicLink.data.email
      : signInErrorCode(passwordSignUp.error) === "waitlisted"
        ? passwordSignUp.variables?.email
        : undefined;
  const waitlistOpen =
    waitlistedEmail !== undefined || redirectError === "waitlisted";
  const verificationEmail =
    passwordSignUp.data?.result === "verify-email"
      ? passwordSignUp.data.email
      : signInErrorCode(passwordSignIn.error) === "EMAIL_NOT_VERIFIED"
        ? passwordSignIn.variables?.email
        : undefined;
  const sentLinkEmail =
    magicLink.data?.outcome === "sent" ? magicLink.data.email : undefined;
  const visibleError =
    requestError !== null &&
    signInErrorCode(requestError) !== "waitlisted" &&
    signInErrorCode(requestError) !== "EMAIL_NOT_VERIFIED"
      ? signInErrorMessage(requestError)
      : redirectError !== undefined && redirectError !== "waitlisted"
        ? signInErrorMessage(redirectError)
        : undefined;

  const title =
    invite !== undefined
      ? `Join ${invite.workspace} on dx`
      : pageMode === "sign-up"
        ? "Create your dx account"
        : "Sign in to dx";
  const subtitle =
    invite !== undefined
      ? "Sign in or create an account to accept the invite."
      : options.admission === "waitlist" && pageMode === "sign-in" && hasLink
        ? "New to dx? Enter your email to join the waitlist."
        : undefined;

  const submitEmail = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    onDismissRedirectError();
    resetRequests();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    if (method === "link") {
      magicLink.mutate({
        email,
        callbackURL: successURL,
        errorCallbackURL: returnPage,
        challenge: challenge.current,
      });
    } else if (showPasswordSignUp) {
      passwordSignUp.mutate({
        name: String(data.get("name") ?? "").trim(),
        email,
        password,
        // Verification returns here signed in; the signed-in router then
        // opens `next`. An invite stays the callback so it admits the account.
        callbackURL: returnPage,
        challenge: challenge.current,
      });
    } else {
      passwordSignIn.mutate({ email, password, callbackURL: returnPage });
    }
  };

  const closeWaitlist = () => {
    onDismissRedirectError();
    resetRequests();
  };

  return (
    <main className="sign-in-page">
      <div className="sign-in-column">
        <DxWordmark />
        <h1 className="sign-in-title">{title}</h1>
        {subtitle === undefined ? null : (
          <p className="sign-in-subtitle">{subtitle}</p>
        )}
        <section className="sign-in-card" aria-label={title}>
          {sentLinkEmail !== undefined ? (
            <CheckEmailPanel
              icon="link"
              title="Check your email"
              email={sentLinkEmail}
              detail="We sent a sign-in link to"
              note="The link expires in 10 minutes and works once."
              resendLabel={
                resendLink.isPending
                  ? "Sending…"
                  : resendLink.isSuccess
                    ? "Sent again"
                    : "Resend link"
              }
              resendError={
                resendLink.error === null
                  ? undefined
                  : signInErrorMessage(resendLink.error)
              }
              onResend={() =>
                magicLink.variables &&
                resendLink.mutate({
                  ...magicLink.variables,
                  // The form is gone; the challenge lives beside it.
                  challenge: challenge.current,
                })
              }
              onBack={resetRequests}
            />
          ) : verificationEmail !== undefined ? (
            <CheckEmailPanel
              icon="verify"
              title="Confirm your email"
              email={verificationEmail}
              detail="We sent a confirmation link to"
              note="Open it to finish setting up your account. The link expires in 1 hour. If this email already has a dx account, we sent a sign-in reminder instead."
              onBack={resetRequests}
            />
          ) : (
            <>
              {hasLink || hasPassword ? (
                <SignInEmailForm
                  method={method}
                  onMethodChange={(next) => {
                    resetRequests();
                    setMethod(next);
                  }}
                  canSwitchMethod={hasLink && hasPassword}
                  passwordSignUp={showPasswordSignUp}
                  allowedEmailDomains={options.allowedEmailDomains}
                  pending={pending}
                  errorId={
                    visibleError === undefined ? undefined : "sign-in-error"
                  }
                  onSubmit={submitEmail}
                />
              ) : null}
              {(hasLink || hasPassword) && hasGoogle ? (
                <div className="sign-in-divider" aria-hidden="true">
                  <span>or</span>
                </div>
              ) : null}
              {hasGoogle ? (
                <Button
                  type="button"
                  variant="outline"
                  className="sign-in-provider"
                  disabled={pending}
                  onClick={() => {
                    onDismissRedirectError();
                    resetRequests();
                    google.mutate({
                      callbackURL: successURL,
                      errorCallbackURL: returnPage,
                    });
                  }}
                >
                  <GoogleIcon />
                  {google.isPending
                    ? "Opening Google…"
                    : "Continue with Google"}
                </Button>
              ) : null}
              {visibleError === undefined ? null : (
                <p id="sign-in-error" className="sign-in-error" role="alert">
                  {visibleError}
                </p>
              )}
              {hasPassword && signUpAllowed ? (
                <p className="sign-in-switch-page">
                  {pageMode === "sign-in"
                    ? "Don't have an account? "
                    : "Already have an account? "}
                  {invite !== undefined ? (
                    <button
                      type="button"
                      className="sign-in-switch-page-action"
                      onClick={() => {
                        resetRequests();
                        setInviteMode(
                          inviteMode === "sign-in" ? "sign-up" : "sign-in",
                        );
                      }}
                    >
                      {pageMode === "sign-in" ? "Sign up" : "Sign in"}
                    </button>
                  ) : pageMode === "sign-in" ? (
                    <Link to="/signup" search={{ next }}>
                      Sign up
                    </Link>
                  ) : (
                    <Link to="/signin" search={{ next }}>
                      Sign in
                    </Link>
                  )}
                </p>
              ) : null}
            </>
          )}
          {/* Outside the form so a resend from the check-email panel can still
              render a Turnstile challenge. */}
          <div ref={challenge} className="sign-in-challenge" />
        </section>
        {options.termsUrl === undefined &&
        options.privacyUrl === undefined ? null : (
          <footer className="sign-in-legal">
            {options.termsUrl === undefined ? null : (
              <a href={options.termsUrl}>Terms of Service</a>
            )}
            {options.privacyUrl === undefined ? null : (
              <a href={options.privacyUrl}>Privacy Policy</a>
            )}
          </footer>
        )}
      </div>
      <WaitlistDialog
        open={waitlistOpen}
        email={waitlistedEmail}
        onClose={closeWaitlist}
      />
    </main>
  );
}
