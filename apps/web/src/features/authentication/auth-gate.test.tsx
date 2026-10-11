// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./auth-gate.js";

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

describe("browser session refresh", () => {
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
