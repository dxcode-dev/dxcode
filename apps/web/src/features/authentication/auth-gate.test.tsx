// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_SESSION_REFETCH_INTERVAL_SECONDS } from "../../shared/auth/auth-client.js";
import {
  AuthenticationModeError,
  AuthGate,
  EmailPasswordAuthForm,
  MagicLinkAuthForm,
} from "./auth-gate.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { authenticationMode, browserSession } = vi.hoisted(() => ({
  authenticationMode: {
    data: {
      mode: "email-password" as "email-password" | "magic-link",
      emailPasswordEnabled: true,
      signupEnabled: false,
    },
    isPending: false,
    error: null,
    refetch: async () => undefined,
  },
  browserSession: {
    data: null as null | {
      readonly user: {
        readonly id: string;
        readonly name: string;
        readonly email: string;
      };
    },
    isPending: false,
    isRefetching: false,
    hasResolved: true,
    error: null,
    refetch: async () => undefined,
  },
}));

vi.mock("../../shared/auth/auth-client.js", async (importOriginal) => ({
  ...(await importOriginal()),
  useBrowserSession: () => browserSession,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal()),
  useQuery: () => authenticationMode,
}));

vi.mock("../marketing/marketing-home.js", () => ({
  MarketingHome: () => <div>Hosted public landing</div>,
}));

vi.mock("./authentication-mutations.js", () => ({
  accessRequestNotice: "Request received.",
  useAccessRequest: () => ({
    data: undefined,
    error: null,
    isPending: false,
    mutate: vi.fn(),
  }),
}));

afterEach(() => {
  authenticationMode.data.mode = "email-password";
  browserSession.data = null;
  browserSession.isPending = false;
  browserSession.isRefetching = false;
  browserSession.hasResolved = true;
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
});

describe("email and password authentication form", () => {
  it("renders an accessible email/password sign-in flow", () => {
    const markup = renderToStaticMarkup(
      <EmailPasswordAuthForm
        pending={false}
        onAuthenticate={() => undefined}
      />,
    );

    expect(markup).toContain("Authentication mode</legend>");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).not.toContain("Cloudflare Access");
  });

  it("renders self-host sign-in without signup or hosted early-access copy", () => {
    const markup = renderToStaticMarkup(
      <EmailPasswordAuthForm
        pending={false}
        signupEnabled={false}
        onAuthenticate={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Sign in to dx"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Sign in");
    expect(markup).not.toContain("Create account");
    expect(markup).not.toContain("Authentication mode</legend>");
    expect(markup).not.toContain("waitlist");
    expect(markup).not.toContain("early access");
    expect(markup).not.toContain("magic link");
  });
});

describe("magic-link authentication form", () => {
  it("renders one email field and a neutral request result as a status", () => {
    const markup = renderToStaticMarkup(
      <MagicLinkAuthForm
        pending={false}
        notice="If this address is approved, check your email."
        onRequest={() => undefined}
      />,
    );

    expect(markup).toContain('type="email"');
    expect(markup).toContain("Email me a sign-in link");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('type="password"');
  });
});

describe("authentication mode error", () => {
  it("renders a visible failure and retry control", () => {
    const markup = renderToStaticMarkup(
      <AuthenticationModeError
        message="Authentication configuration failed."
        onRetry={() => undefined}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Authentication configuration failed.");
    expect(markup).toContain("Try again");
  });
});

describe("browser session refresh", () => {
  it("uses Better Auth's seconds-based interval just after cache expiry", () => {
    expect(BROWSER_SESSION_REFETCH_INTERVAL_SECONDS).toBe(3_615);
  });

  it.each([
    ["self-host sign-in", "email-password" as const, "/projects"],
    ["hosted public landing", "magic-link" as const, "/"],
  ])(
    "does not render %s while a persisted session is resolving",
    async (_surface, mode, path) => {
      window.history.replaceState(null, "", path);
      authenticationMode.data.mode = mode;
      browserSession.data = null;
      browserSession.isPending = true;
      browserSession.isRefetching = true;
      browserSession.hasResolved = false;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <AuthGate>
            <div>Authenticated application</div>
          </AuthGate>,
        );
      });

      expect(container.textContent).not.toContain("Sign in");
      expect(container.textContent).not.toContain("Hosted public landing");

      browserSession.data = {
        user: {
          id: "usr_00000000-0000-4000-8000-000000000001",
          name: "Owner",
          email: "owner@example.com",
        },
      };
      browserSession.isPending = false;
      browserSession.isRefetching = false;
      browserSession.hasResolved = true;
      await act(async () => {
        root.render(
          <AuthGate>
            <div>Authenticated application</div>
          </AuthGate>,
        );
      });

      expect(container.textContent).toContain("Authenticated application");
      await act(async () => root.unmount());
    },
  );

  it("preserves the signed-out form across a focus refetch until auth state changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AuthGate>
          <div>Authenticated application</div>
        </AuthGate>,
      );
    });
    const email =
      container.querySelector<HTMLInputElement>("input[type=email]");
    expect(email).not.toBeNull();
    if (email === null) return;
    email.value = "kept@example.com";

    browserSession.isPending = true;
    browserSession.isRefetching = true;
    await act(async () => {
      root.render(
        <AuthGate>
          <div>Authenticated application</div>
        </AuthGate>,
      );
    });

    expect(container.querySelector("input[type=email]")).toBe(email);
    expect(email.value).toBe("kept@example.com");

    browserSession.data = {
      user: {
        id: "usr_00000000-0000-4000-8000-000000000001",
        name: "Owner",
        email: "owner@example.com",
      },
    };
    browserSession.isPending = false;
    browserSession.isRefetching = false;
    await act(async () => {
      root.render(
        <AuthGate>
          <div>Authenticated application</div>
        </AuthGate>,
      );
    });

    expect(container.querySelector("input[type=email]")).toBeNull();
    expect(container.textContent).toContain("Authenticated application");
    await act(async () => root.unmount());
  });
});
