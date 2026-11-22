import type { SignInOptionsResponse } from "@dx/api";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { AuthLayout, type AuthScreen } from "./auth-layout.js";
import {
  AuthAlert,
  AuthCheckEmail,
  AuthConfirmEmail,
  AuthDivider,
  AuthEmailForm,
  type AuthEmailMethod,
  AuthLegalLinks,
  AuthProviderButtons,
  AuthSwitch,
  AuthTerms,
  AuthWaitlisted,
} from "./auth-parts.js";
import { AuthShowcase } from "./auth-showcase.js";
import { signInErrorCode, signInErrorMessage } from "./sign-in-errors.js";
import {
  useGoogleSignIn,
  useMagicLinkRequest,
  usePasswordSignIn,
  usePasswordSignUp,
} from "./sign-in-mutations.js";
import { signInHref } from "./sign-in-paths.js";

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
  const waitlist = options.admission === "waitlist" && invite === undefined;
  // An invite page has one URL for both: new people create an account,
  // existing ones sign in.
  const [inviteMode, setInviteMode] = React.useState<SignInPageMode>("sign-up");
  const pageMode = invite === undefined ? mode : inviteMode;
  const showPasswordSignUp =
    pageMode === "sign-up" && hasPassword && signUpAllowed;

  const [method, setMethod] = React.useState<AuthEmailMethod>(
    hasLink ? "link" : "password",
  );
  // Set once the person comes back to the form from a later step; the first
  // screen paints without motion, and typing or submitting never replays it.
  const [returned, setReturned] = React.useState(false);
  // The address last submitted, kept for the form when the person comes back.
  const [lastEmail, setLastEmail] = React.useState<string>();
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
    magicLink.isPending || passwordSignIn.isPending || passwordSignUp.isPending;
  const busy = pending || google.isPending;

  const resetRequests = () => {
    magicLink.reset();
    resendLink.reset();
    passwordSignIn.reset();
    passwordSignUp.reset();
    google.reset();
  };
  const startOver = () => {
    onDismissRedirectError();
    resetRequests();
    setReturned(true);
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
  const waitlisted =
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
      ? signInErrorMessage(requestError, options)
      : redirectError !== undefined && redirectError !== "waitlisted"
        ? signInErrorMessage(redirectError, options)
        : undefined;

  const step: AuthScreen = waitlisted
    ? "waitlisted"
    : sentLinkEmail !== undefined
      ? "check-email"
      : verificationEmail !== undefined
        ? "verify-email"
        : invite !== undefined
          ? "join"
          : pageMode === "sign-up"
            ? "signup"
            : "signin";
  const formStep = step === "signin" || step === "signup" || step === "join";
  const stepKey =
    (formStep && !returned) ||
    // A provider redirect lands straight on the waitlist: no motion.
    (step === "waitlisted" && waitlistedEmail === undefined)
      ? undefined
      : step;

  const submitEmail = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    onDismissRedirectError();
    resetRequests();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    setLastEmail(email);
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

  const legal = { termsUrl: options.termsUrl, privacyUrl: options.privacyUrl };
  // Outside the form so a resend from the check-email step can still render
  // a Turnstile challenge.
  const challengeSlot = <div ref={challenge} className="auth-challenge" />;

  if (step === "waitlisted")
    return (
      <AuthWaitlisted
        email={waitlistedEmail}
        stepKey={stepKey}
        onBack={startOver}
      />
    );

  if (step === "check-email" && sentLinkEmail !== undefined)
    return (
      <AuthCheckEmail
        email={sentLinkEmail}
        stepKey={stepKey}
        resend={
          resendLink.isPending
            ? "sending"
            : resendLink.isSuccess
              ? "sent"
              : "idle"
        }
        resendError={
          resendLink.error === null
            ? undefined
            : signInErrorMessage(resendLink.error, options)
        }
        onResend={() =>
          magicLink.variables &&
          resendLink.mutate({
            ...magicLink.variables,
            // The form is gone; the challenge lives beside it.
            challenge: challenge.current,
          })
        }
        onBack={startOver}
      >
        {challengeSlot}
      </AuthCheckEmail>
    );

  if (step === "verify-email" && verificationEmail !== undefined)
    return (
      <AuthConfirmEmail
        email={verificationEmail}
        stepKey={stepKey}
        onBack={startOver}
      />
    );

  const { title, subtitle } = formCopy(pageMode, waitlist && hasLink, invite);

  return (
    <AuthLayout
      aside={<AuthShowcase />}
      screen={step}
      title={title}
      subtitle={subtitle}
      stepKey={stepKey}
      footer={
        pageMode === "sign-in" ? <AuthLegalLinks {...legal} /> : undefined
      }
    >
      {hasGoogle ? (
        <>
          <AuthProviderButtons
            providers={["google"]}
            opening={google.isPending ? "google" : undefined}
            disabled={busy}
            onSelect={() => {
              onDismissRedirectError();
              resetRequests();
              google.mutate({
                callbackURL: successURL,
                errorCallbackURL: returnPage,
              });
            }}
          />
          {hasLink || hasPassword ? <AuthDivider /> : null}
        </>
      ) : null}
      {hasLink || hasPassword ? (
        <AuthEmailForm
          method={method}
          creating={showPasswordSignUp}
          waitlist={waitlist && pageMode === "sign-up"}
          allowedEmailDomains={options.allowedEmailDomains}
          pending={pending}
          disabled={google.isPending}
          error={visibleError}
          canSwitchMethod={hasLink && hasPassword}
          onMethodChange={(nextMethod) => {
            // A new method starts over, as a new submission does.
            onDismissRedirectError();
            resetRequests();
            setMethod(nextMethod);
          }}
          onSubmit={submitEmail}
          defaultEmail={lastEmail}
        />
      ) : visibleError === undefined ? null : (
        <AuthAlert id="sign-in-error">{visibleError}</AuthAlert>
      )}
      {hasPassword && signUpAllowed ? (
        <SwitchPage
          to={pageMode === "sign-in" ? "sign-up" : "sign-in"}
          next={next}
          onSwitchInvite={
            invite === undefined
              ? undefined
              : (target) => {
                  resetRequests();
                  setInviteMode(target);
                }
          }
        />
      ) : null}
      {pageMode === "sign-up" ? <AuthTerms {...legal} /> : null}
      {challengeSlot}
    </AuthLayout>
  );
}

/** The form step's heading and line under it. */
function formCopy(
  pageMode: SignInPageMode,
  waitlist: boolean,
  invite: SignInPageProps["invite"],
) {
  if (invite !== undefined)
    return {
      title: `Join ${invite.workspace} on dx`,
      subtitle:
        "You're invited to this workspace on dx. Sign in or create an account to accept.",
    };
  if (pageMode === "sign-up")
    return waitlist
      ? {
          title: "Join the dx waitlist",
          subtitle:
            "Enter your email. We'll send an invite as soon as your account is ready.",
        }
      : {
          title: "Create your dx account",
          subtitle: "Start your trial and hand your first task to an agent.",
        };
  return {
    title: "Sign in to dx",
    subtitle: waitlist
      ? "New to dx? Enter your email to join the waitlist."
      : "Pick up where your agents left off.",
  };
}

/**
 * "New to dx? Create an account" or "Have an account? Sign in": a link
 * between the two pages, or on an invite, which has one URL for both, a
 * button that switches in place.
 */
function SwitchPage({
  to,
  next,
  onSwitchInvite,
}: {
  readonly to: SignInPageMode;
  readonly next: string | undefined;
  readonly onSwitchInvite?: (to: SignInPageMode) => void;
}) {
  const label = to === "sign-up" ? "Create an account" : "Sign in";
  return (
    <AuthSwitch prompt={to === "sign-up" ? "New to dx?" : "Have an account?"}>
      {onSwitchInvite !== undefined ? (
        <button type="button" onClick={() => onSwitchInvite(to)}>
          {label}
        </button>
      ) : (
        <Link to={to === "sign-up" ? "/signup" : "/signin"} search={{ next }}>
          {label}
        </Link>
      )}
    </AuthSwitch>
  );
}
