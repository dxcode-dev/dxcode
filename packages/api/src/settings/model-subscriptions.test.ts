import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { BeginPersonalModelSubscriptionAuthorizationResponseSchema } from "./model-subscriptions.js";

describe("personal model subscription HTTP contracts", () => {
  it.each(["deviceCode", "token", "credentialEnvelope", "credentialRevision"])(
    "rejects credential field %s",
    (field) => {
      expect(() =>
        Schema.decodeUnknownSync(
          BeginPersonalModelSubscriptionAuthorizationResponseSchema,
          { onExcessProperty: "error" },
        )({
          status: "success",
          data: {
            id: "authorization-1",
            provider: "github-copilot",
            verificationUrl: "https://github.com/login/device",
            userCode: "ABCD-1234",
            expiresAt: "2026-08-29T10:15:00.000Z",
            intervalSeconds: 5,
            nextPollAt: "2026-08-29T10:00:05.000Z",
            state: "pending",
            [field]: "secret",
          },
        }),
      ).toThrow();
    },
  );
});
