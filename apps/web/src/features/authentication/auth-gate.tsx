import { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import * as React from "react";
import {
  signInWithEmail,
  signOut,
  signUpWithEmail,
  useBrowserSession,
} from "../../shared/auth/auth-client.js";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { AppFrame } from "../../shared/layout/app-frame.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import {
  accessRequestNotice,
  useAccessRequest,
} from "./authentication-mutations.js";
import { authenticationModeQueryOptions } from "./authentication-queries.js";

type EmailAuthMode = "sign-in" | "sign-up";

const MarketingHome = React.lazy(() =>
  import("../marketing/marketing-home.js").then((module) => ({
    default: module.MarketingHome,
  })),
);

const DxMark = React.lazy(() =>
  import("../../shared/brand/dx-mark.js").then((module) => ({
    default: module.DxMark,
  })),
);

const DxLoading = React.lazy(() =>
  import("../../shared/brand/dx-loading.js").then((module) => ({
    default: module.DxLoading,
  })),
);

/** Renders the email sign-in and account-creation controls shared by auth gates. */
export function EmailPasswordAuthForm({
  pending,
  error,
  signupEnabled = true,
  title: providedTitle,
  onAuthenticate,
}: {
  readonly pending: boolean;
  readonly error?: string;
  readonly signupEnabled?: boolean;
  readonly title?: string;
  readonly onAuthenticate: (
    mode: EmailAuthMode,
    input: {
      readonly name: string;
      readonly email: string;
      readonly password: string;
    },
  ) => void;
}) {
  const [mode, setMode] = React.useState<EmailAuthMode>("sign-in");
  const title =
    providedTitle ??
    (mode === "sign-in" ? "Sign in to dx" : "Create an account");
  return (
    <section
      className="auth-local-card"
      aria-labelledby="email-auth-title"
      aria-label={signupEnabled ? undefined : title}
    >
      {signupEnabled ? (
        <fieldset className="auth-local-tabs">
          <legend className="visually-hidden">Authentication mode</legend>
          <Button
            size="sm"
            variant={mode === "sign-in" ? "secondary" : "ghost"}
            aria-pressed={mode === "sign-in"}
            onClick={() => setMode("sign-in")}
          >
            Sign in
          </Button>
          <Button
            size="sm"
            variant={mode === "sign-up" ? "secondary" : "ghost"}
            aria-pressed={mode === "sign-up"}
            onClick={() => setMode("sign-up")}
          >
            Create account
          </Button>
        </fieldset>
      ) : null}
      <div>
        <strong id="email-auth-title">{title}</strong>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onAuthenticate(mode, {
            name: String(data.get("name") ?? ""),
            email: String(data.get("email") ?? ""),
            password: String(data.get("password") ?? ""),
          });
        }}
      >
        {signupEnabled && mode === "sign-up" ? (
          <div>
            <label htmlFor="email-auth-name">Name</label>
            <Input
              id="email-auth-name"
              name="name"
              autoComplete="name"
              required
              maxLength={128}
            />
          </div>
        ) : null}
        <div>
          <label htmlFor="email-auth-email">Email</label>
          <Input
            id="email-auth-email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </div>
        <div>
          <label htmlFor="email-auth-password">Password</label>
          <Input
            id="email-auth-password"
            name="password"
            type="password"
            autoComplete={
              mode === "sign-in" ? "current-password" : "new-password"
            }
            minLength={8}
            maxLength={128}
            required
          />
        </div>
        {error === undefined ? null : (
          <p className="auth-local-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending
            ? "Please wait…"
            : mode === "sign-in"
              ? "Sign in"
              : "Create account"}
        </Button>
      </form>
    </section>
  );
}

/** Renders passwordless sign-in and waitlist enrollment. */
export function MagicLinkAuthForm({
  pending,
  error,
  notice,
  onRequest,
}: {
  readonly pending: boolean;
  readonly error?: string;
  readonly notice?: string;
  readonly onRequest: (email: string, container: HTMLElement) => void;
}) {
  const challenge = React.useRef<HTMLDivElement>(null);
  return (
    <section className="auth-local-card" aria-labelledby="magic-link-title">
      <div>
        <strong id="magic-link-title">Sign in to dx</strong>
        <p>Enter your email to receive a one-time sign-in link.</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          if (!pending && challenge.current)
            onRequest(String(data.get("email") ?? ""), challenge.current);
        }}
      >
        <div>
          <label htmlFor="magic-link-email">Email</label>
          <Input
            id="magic-link-email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </div>
        <div ref={challenge} />
        {error === undefined ? null : (
          <p className="auth-local-error" role="alert">
            {error}
          </p>
        )}
        {notice === undefined ? null : (
          <p className="auth-local-notice" role="status">
            {notice}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Please wait…" : "Email me a sign-in link"}
        </Button>
      </form>
    </section>
  );
}

export function AuthenticationModeError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <section className="auth-local-card">
      <p className="auth-local-error" role="alert">
        {message}
      </p>
      <Button type="button" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}

/** Routes signed-out visitors to authentication and provides identity to signed-in children. */
export function AuthGate({
  children,
  onBeforeSignOut,
}: {
  readonly children: React.ReactNode;
  readonly onBeforeSignOut?: (userId: UserId) => void;
}) {
  const session = useBrowserSession();
  const authenticationMode = useQuery(authenticationModeQueryOptions);
  const [actionPending, setActionPending] = React.useState(false);
  const [actionError, setActionError] = React.useState<string>();
  const accessRequest = useAccessRequest();

  const run = React.useCallback(
    (operation: Effect.Effect<void, { readonly message: string }>) => {
      setActionPending(true);
      setActionError(undefined);

      Effect.runFork(
        operation.pipe(
          Effect.tapError((error) =>
            Effect.sync(() => setActionError(error.message)),
          ),
          Effect.ensuring(Effect.sync(() => setActionPending(false))),
        ),
      );
    },
    [],
  );

  const authenticateWithEmail = React.useCallback(
    (
      mode: EmailAuthMode,
      input: {
        readonly name: string;
        readonly email: string;
        readonly password: string;
      },
    ) => {
      const operation =
        mode === "sign-in"
          ? signInWithEmail({ email: input.email, password: input.password })
          : signUpWithEmail(input);
      run(
        operation.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => session.refetch(),
              catch: () => ({ message: "Session refresh failed." }),
            }),
          ),
        ),
      );
    },
    [run, session.refetch],
  );

  const identity = React.useMemo(
    () =>
      session.data === null
        ? undefined
        : {
            id: Schema.decodeUnknownSync(UserId)(session.data.user.id),
            name: session.data.user.name,
            email: session.data.user.email,
          },
    [session.data],
  );
  const logout = React.useCallback(() => {
    run(
      signOut.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (identity !== undefined) onBeforeSignOut?.(identity.id);
          }),
        ),
      ),
    );
  }, [identity, onBeforeSignOut, run]);
  const context = React.useMemo(
    () => (identity === undefined ? undefined : { identity, logout }),
    [identity, logout],
  );

  const sessionUnresolved = session.isPending && !session.hasResolved;
  const pending =
    sessionUnresolved || authenticationMode.isPending || actionPending;
  const isPublicHome = window.location.pathname === "/";
  const isHostedPublicHome =
    isPublicHome && authenticationMode.data?.mode === "magic-link";
  let content: React.ReactNode;

  if (sessionUnresolved) {
    content = (
      <AppFrame>
        <main className="auth-gate-surface" aria-busy="true" />
      </AppFrame>
    );
  } else if (context === undefined) {
    const modeError =
      authenticationMode.error instanceof Error
        ? authenticationMode.error.message
        : undefined;
    const error = actionError ?? session.error?.message ?? modeError;
    const form =
      authenticationMode.data?.mode === "magic-link" ? (
        <>
          <MagicLinkAuthForm
            pending={pending || accessRequest.isPending}
            error={
              accessRequest.error instanceof Error
                ? accessRequest.error.message
                : error
            }
            notice={
              accessRequest.data === undefined ? undefined : accessRequestNotice
            }
            onRequest={(email, container) =>
              accessRequest.mutate({ email, container })
            }
          />
          {authenticationMode.data.emailPasswordEnabled ? (
            <EmailPasswordAuthForm
              pending={pending}
              error={error}
              signupEnabled={false}
              title="Reviewer sign-in"
              onAuthenticate={authenticateWithEmail}
            />
          ) : null}
        </>
      ) : authenticationMode.data?.mode === "email-password" ? (
        <EmailPasswordAuthForm
          pending={pending}
          error={error}
          signupEnabled={authenticationMode.data.signupEnabled ?? true}
          onAuthenticate={authenticateWithEmail}
        />
      ) : authenticationMode.isPending ? null : (
        <AuthenticationModeError
          message={error ?? "Authentication configuration failed."}
          onRetry={() => void authenticationMode.refetch()}
        />
      );
    content = isHostedPublicHome ? (
      <React.Suspense fallback={null}>
        <MarketingHome />
      </React.Suspense>
    ) : (
      <AppFrame>
        <main className="auth-gate-surface" aria-busy={pending}>
          {pending ? null : (
            <>
              <React.Suspense fallback={null}>
                <DxMark state="idle" className="auth-gate-mark" />
              </React.Suspense>
              <div className="auth-gate-card">
                <strong>Sign in required</strong>
                {form}
              </div>
            </>
          )}
        </main>
      </AppFrame>
    );
  } else {
    content = (
      <AuthContext.Provider value={context}>{children}</AuthContext.Provider>
    );
  }

  return (
    <>
      {content}
      {pending && (!isHostedPublicHome || sessionUnresolved) ? (
        <React.Suspense fallback={null}>
          <DxLoading
            label={
              sessionUnresolved || authenticationMode.isPending
                ? "Loading dx…"
                : "Signing in…"
            }
            variant="screen"
          />
        </React.Suspense>
      ) : null}
    </>
  );
}
