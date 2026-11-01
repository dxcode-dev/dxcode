// A sign-in link that failed returns to `/signin?error=…`. Switching to the
// other sign-in method starts over, so the link error and its `?error=` must
// go, as they do on a new submission (#1173).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { validateSignInSearch } from "./sign-in-paths.js";
import { signInOptionsQueryOptions } from "./sign-in-queries.js";
import { SignInRoute } from "./sign-in-route.js";

let root: Root | undefined;

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const mountSignIn = async (url: string) => {
  const client = new QueryClient();
  client.setQueryData(signInOptionsQueryOptions.queryKey, {
    providers: ["magic-link", "email-password"],
    admission: "open",
    allowedEmailDomains: [],
    emailVerification: false,
  });
  const rootRoute = createRootRoute();
  const signIn = createRoute({
    getParentRoute: () => rootRoute,
    path: "/signin",
    validateSearch: validateSignInSearch,
    component: SignInRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([signIn]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitUntil(() => container.querySelector("form"));
  return { container, router };
};

const switchButton = (container: HTMLElement, label: string) => {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Missing "${label}"`);
  return button;
};

it.each([
  ["EXPIRED_TOKEN", "That link has expired. Request a new one below."],
  [
    "INVALID_TOKEN",
    "That link is invalid or was already used. Request a new one below.",
  ],
])(
  "switching to a password clears the %s link error and its ?error=",
  async (code, message) => {
    const { container, router } = await mountSignIn(
      `/signin?error=${code}&next=%2Fthreads%2Fthr_1`,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      message,
    );

    await userEvent.click(switchButton(container, "Sign in with a password"));
    expect(container.querySelector("#sign-in-password")).not.toBeNull();
    await vi.waitUntil(() => router.state.location.search.error === undefined, {
      timeout: 1000,
    });
    expect(router.state.location.search).toEqual({ next: "/threads/thr_1" });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container
        .querySelector("#sign-in-email")
        ?.getAttribute("aria-describedby"),
    ).toBeNull();

    const email = container.querySelector<HTMLInputElement>("#sign-in-email");
    if (email === null) throw new Error("Missing email field");
    await userEvent.type(email, "reader@example.com");
    expect(container.textContent).not.toContain(message);

    // Switching back starts a fresh link request; the old error stays gone.
    await userEvent.click(
      switchButton(container, "Email me a sign-in link instead"),
    );
    expect(container.textContent).not.toContain(message);
  },
);
