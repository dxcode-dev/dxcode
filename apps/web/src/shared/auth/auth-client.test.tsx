// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useBrowserSession } from "./auth-client.js";

const { client, sessionOptions } = vi.hoisted(() => ({
  client: {
    useSession: () => ({
      data: null,
      isPending: true,
      isRefetching: true,
      error: null,
      refetch: async () => undefined,
    }),
    signOut: vi.fn(),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
  },
  sessionOptions: {
    onSuccess: undefined as undefined | (() => void),
  },
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: (options: {
    sessionOptions: { onSuccess?: () => void };
  }) => {
    sessionOptions.onSuccess = options.sessionOptions.onSuccess;
    return client;
  },
}));

vi.mock("@better-auth/api-key/client", () => ({ apiKeyClient: () => ({}) }));

afterEach(() => document.body.replaceChildren());

it("publishes Better Auth's first session resolution", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Probe() {
    const session = useBrowserSession();
    return <div>{session.hasResolved ? "resolved" : "pending"}</div>;
  }

  await act(async () => root.render(<Probe />));
  expect(container.textContent).toBe("pending");

  await act(async () => sessionOptions.onSuccess?.());
  expect(container.textContent).toBe("resolved");

  await act(async () => root.unmount());
});
