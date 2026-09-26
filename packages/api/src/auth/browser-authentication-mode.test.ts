import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { BrowserAuthenticationModeResponseSchema } from "./browser-authentication-mode.js";

describe("browser authentication mode response", () => {
  it.each(["email-password", "magic-link"])("accepts %s", (mode) => {
    expect(
      Schema.decodeUnknownSync(BrowserAuthenticationModeResponseSchema)({
        mode,
      }),
    ).toEqual({ mode });
  });

  it("advertises the optional branch-preview reviewer password method", () => {
    expect(
      Schema.decodeUnknownSync(BrowserAuthenticationModeResponseSchema)({
        mode: "magic-link",
        emailPasswordEnabled: true,
      }),
    ).toEqual({ mode: "magic-link", emailPasswordEnabled: true });
  });

  it.each([true, false])(
    "advertises whether signup is enabled",
    (signupEnabled) => {
      expect(
        Schema.decodeUnknownSync(BrowserAuthenticationModeResponseSchema)({
          mode: "email-password",
          signupEnabled,
        }),
      ).toEqual({ mode: "email-password", signupEnabled });
    },
  );

  it("rejects a false password-method advertisement", () => {
    expect(() =>
      Schema.decodeUnknownSync(BrowserAuthenticationModeResponseSchema)({
        mode: "magic-link",
        emailPasswordEnabled: false,
      }),
    ).toThrow();
  });

  it("rejects unknown modes", () => {
    expect(() =>
      Schema.decodeUnknownSync(BrowserAuthenticationModeResponseSchema)({
        mode: "passwordless",
      }),
    ).toThrow();
  });
});
