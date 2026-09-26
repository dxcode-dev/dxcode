import { describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "./webhooks.js";

describe("GitHub webhook signature verification", () => {
  it("matches GitHub's official HMAC-SHA256 test vector", async () => {
    const body = new TextEncoder().encode("Hello, World!");
    const signature =
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    await expect(
      verifyGitHubWebhookSignature(
        body,
        signature,
        "It's a Secret to Everybody",
      ),
    ).resolves.toBe(true);
    await expect(
      verifyGitHubWebhookSignature(body, signature, "wrong secret"),
    ).resolves.toBe(false);
  });

  it.each(["", "sha1=abc", "sha256=ABC", `sha256=${"a".repeat(63)}`])(
    "rejects malformed signatures without throwing: %s",
    async (signature) => {
      await expect(
        verifyGitHubWebhookSignature(new Uint8Array(), signature, "secret"),
      ).resolves.toBe(false);
    },
  );
});
