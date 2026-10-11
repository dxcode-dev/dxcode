// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSignInOptions,
  requestMagicLink,
} from "../../shared/auth/auth-client.js";
import { requestTurnstileToken } from "../authentication/turnstile.js";
import { LiveAccessContext } from "./prototype/live-access-context.js";
import { WaitlistForm } from "./prototype/waitlist-form.js";

vi.mock("../../shared/auth/auth-client.js", async (original) => ({
  ...(await original<typeof import("../../shared/auth/auth-client.js")>()),
  getSignInOptions: vi.fn(),
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
      vi.mocked(getSignInOptions).mockResolvedValue({
        providers: ["magic-link"],
        admission: "waitlist",
        allowedEmailDomains: [],
        emailVerification: false,
        turnstileSiteKey: "public-key",
      });
      vi.mocked(requestTurnstileToken)
        .mockResolvedValueOnce("first-token")
        .mockResolvedValueOnce("fresh-token");
      vi.mocked(requestMagicLink)
        .mockRejectedValueOnce(new Error("Please retry"))
        .mockResolvedValueOnce("sent");
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
          expect.objectContaining({
            email: "reader@example.com",
            turnstileToken: "first-token",
            callbackURL: "/new",
          }),
        );
        await submit();
        expect(requestMagicLink).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            email: "reader@example.com",
            turnstileToken: "fresh-token",
            callbackURL: "/new",
          }),
        );
        expect(element.textContent).toContain(
          "Check your email. We sent a sign-in link to reader@example.com.",
        );
        expect(element.textContent).not.toContain("Signup is not connected");
      } finally {
        await act(async () => root.unmount());
        client.clear();
        element.remove();
      }
    },
  );
});
