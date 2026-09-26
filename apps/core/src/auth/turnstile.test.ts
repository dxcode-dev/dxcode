import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "./turnstile.js";

afterEach(() => vi.unstubAllGlobals());
const input = { token: "token", secret: "secret", hostname: "dx.test" };
describe("Turnstile admission protection", () => {
  it.each([null, "", "x".repeat(2049)])(
    "rejects invalid tokens without a verification request",
    async (token) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(
        Effect.runPromise(verifyTurnstile({ ...input, token })),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("fails closed without a secret", async () => {
    await expect(
      Effect.runPromise(verifyTurnstile({ ...input, secret: undefined })),
    ).rejects.toThrow("not configured");
  });
  it.each([
    { success: false },
    { success: true, hostname: "other.test", action: "dx-access" },
    { success: true, hostname: "dx.test", action: "other" },
    { success: true },
  ])(
    "rejects failed, replayed, or mismatched verification: %j",
    async (result) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(result)),
      );
      await expect(Effect.runPromise(verifyTurnstile(input))).rejects.toThrow();
    },
  );
  it("accepts a valid token with the expected hostname and action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          hostname: "dx.test",
          action: "dx-access",
        }),
      ),
    );
    await expect(
      Effect.runPromise(verifyTurnstile(input)),
    ).resolves.toBeUndefined();
  });
  it("fails closed on verification outages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(Effect.runPromise(verifyTurnstile(input))).rejects.toThrow(
      "unavailable",
    );
  });
});
