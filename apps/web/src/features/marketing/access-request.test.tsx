// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Effect } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserAuthenticationConfiguration,
  requestMagicLink,
} from "../authentication/authentication-requests.js";
import { requestTurnstileToken } from "../authentication/turnstile.js";
import { LiveAccessContext } from "./prototype/live-access-context.js";
import { WaitlistForm } from "./prototype/waitlist-form.js";

vi.mock("../authentication/authentication-requests.js", () => ({
  getBrowserAuthenticationConfiguration: vi.fn(),
  getBrowserAuthenticationMode: vi.fn(),
  requestMagicLink: vi.fn(),
}));
vi.mock("../authentication/turnstile.js", () => ({
  requestTurnstileToken: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.resetAllMocks());

describe("landing access submission", () => {
  it.each([true, false])(
    "connects the hero=%s form, retains input on failure, and retries with a new token",
    async (hero) => {
      vi.mocked(getBrowserAuthenticationConfiguration).mockResolvedValue({
        mode: "magic-link",
        turnstileSiteKey: "public-key",
      });
      vi.mocked(requestTurnstileToken)
        .mockResolvedValueOnce("first-token")
        .mockResolvedValueOnce("fresh-token");
      vi.mocked(requestMagicLink)
        .mockReturnValueOnce(Effect.die(new Error("Please retry")))
        .mockReturnValueOnce(Effect.succeed("request-accepted"));
      const element = document.createElement("div");
      document.body.append(element);
      const root = createRoot(element);
      const client = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      try {
        await act(async () =>
          root.render(
            <QueryClientProvider client={client}>
              <LiveAccessContext.Provider value={true}>
                <WaitlistForm hero={hero} />
              </LiveAccessContext.Provider>
            </QueryClientProvider>,
          ),
        );
        const input = element.querySelector("input");
        if (!input) throw new Error("Missing email input");
        input.value = "reader@example.com";
        const submit = async () => {
          await act(async () => {
            element
              .querySelector("form")
              ?.dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
              );
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
        };
        await submit();
        expect(element.querySelector('[role="alert"]')).not.toBeNull();
        expect(input.value).toBe("reader@example.com");
        expect(requestMagicLink).toHaveBeenNthCalledWith(
          1,
          "reader@example.com",
          "first-token",
          "/new",
        );
        await submit();
        expect(requestMagicLink).toHaveBeenNthCalledWith(
          2,
          "reader@example.com",
          "fresh-token",
          "/new",
        );
        expect(element.textContent).toContain(
          "Check your email for a sign-in link. If one doesn’t arrive, your address is on the waitlist.",
        );
        expect(element.textContent).not.toContain("Signup is not connected");
      } finally {
        await act(async () => root.unmount());
        client.clear();
        element.remove();
      }
    },
  );

  it("uses the same neutral confirmation for every accepted request", async () => {
    vi.mocked(getBrowserAuthenticationConfiguration).mockResolvedValue({
      mode: "magic-link",
      turnstileSiteKey: "public-key",
    });
    vi.mocked(requestTurnstileToken).mockResolvedValue("token");
    vi.mocked(requestMagicLink).mockReturnValue(
      Effect.succeed("request-accepted"),
    );
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const client = new QueryClient();
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <LiveAccessContext.Provider value={true}>
              <WaitlistForm />
            </LiveAccessContext.Provider>
          </QueryClientProvider>,
        ),
      );
      const input = element.querySelector<HTMLInputElement>("input");
      if (!input) throw new Error("Missing email input");
      input.value = "approved@example.com";
      await act(async () => {
        element
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(element.textContent).toContain(
        "Check your email for a sign-in link. If one doesn’t arrive, your address is on the waitlist.",
      );
    } finally {
      await act(async () => root.unmount());
      client.clear();
      element.remove();
    }
  });
});
