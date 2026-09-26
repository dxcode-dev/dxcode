import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  PendingPersonalModelSubscriptionAuthorization,
  PersonalModelSubscriptionConnection,
} from "./model-subscriptions.js";

const connection = {
  id: "subscription-1",
  ownerUserId: "dx-user-1",
  provider: "github-copilot",
  providerAccountId: "github-account-987",
  providerAccountLogin: "octocat",
  status: "connected",
  entitlement: {
    modelIds: ["gpt-5"],
    catalogRevision: "catalog-7",
    observedAt: "2026-08-29T10:00:00.000Z",
    refreshAfter: "2026-08-29T11:00:00.000Z",
  },
  createdAt: "2026-08-29T09:00:00.000Z",
  updatedAt: "2026-08-29T10:00:00.000Z",
  connectedAt: "2026-08-29T09:05:00.000Z",
};

describe("personal model subscription domain", () => {
  it("keeps the dx owner identity independent from the provider account", () => {
    const decoded = Schema.decodeUnknownSync(
      PersonalModelSubscriptionConnection,
    )(connection);
    expect(decoded.ownerUserId).toBe("dx-user-1");
    expect(decoded.providerAccountId).toBe("github-account-987");
  });

  it.each(["authorizing", "disconnected", "unavailable"])(
    "rejects phantom connection lifecycle %s",
    (status) => {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(PersonalModelSubscriptionConnection)({
            ...connection,
            status,
          }),
        ),
      ).toBe(true);
    },
  );

  it("rejects secret material and non-pending authorization state", () => {
    const pending = {
      id: "authorization-1",
      ownerUserId: "dx-user-1",
      browserSessionId: "browser-session-1",
      provider: "github-copilot",
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresAt: "2026-08-29T10:15:00.000Z",
      intervalSeconds: 5,
      nextPollAt: "2026-08-29T10:00:05.000Z",
      state: "pending",
    };
    expect(() =>
      Schema.decodeUnknownSync(PendingPersonalModelSubscriptionAuthorization, {
        onExcessProperty: "error",
      })({ ...pending, deviceCode: "must-not-leak" }),
    ).toThrow();
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(
          PendingPersonalModelSubscriptionAuthorization,
        )({
          ...pending,
          state: "approved",
        }),
      ),
    ).toBe(true);
  });
});
