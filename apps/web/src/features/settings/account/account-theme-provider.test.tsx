// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { AccountThemeProvider } from "./account-theme-provider.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const account = {
  displayName: "Test User",
  username: "test-user",
  email: "test@example.com",
  emailVerified: true,
  identityAuthority: "local-password",
  threadCount: 2,
  appearance: "light",
  palette: "deadpan",
  terminalTheme: "github",
} as const;

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("AccountThemeProvider", () => {
  it("offers a retry when the account theme cannot be loaded", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("account unavailable"))
      .mockResolvedValueOnce(
        Response.json({ status: "success", data: account }),
      );
    vi.stubGlobal("fetch", fetch);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider
            value={{
              identity: {
                id: "user-1" as never,
                name: "Test User",
                email: "test@example.com",
              },
              logout: () => undefined,
            }}
          >
            <AccountThemeProvider>
              <div>Authenticated application</div>
            </AccountThemeProvider>
          </AuthContext.Provider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Appearance settings could not be loaded.",
      ),
    );

    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Try again",
    );
    await React.act(() => retry?.click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Authenticated application"),
    );
    expect(document.documentElement.dataset.resolvedAppearance).toBe("light");
    expect(fetch).toHaveBeenCalledTimes(2);
    await React.act(() => root.unmount());
  });
});
