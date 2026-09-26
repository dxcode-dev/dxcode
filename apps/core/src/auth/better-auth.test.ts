import { describe, expect, expectTypeOf, it } from "vitest";
import { createTestBindings, validD1Binding } from "../testing/bindings.js";
import {
  browserAuthenticationMode,
  createAuth,
  reviewerPasswordEnabled,
  selfhostSignupEnabled,
} from "./better-auth.js";
import type { AuthenticationRequirements } from "./requirements.js";

const requirements = (environment: string): AuthenticationRequirements => ({
  environment,
  authUrl: "https://dx.example.com",
  trustedOrigins: ["https://dx.example.com"],
  secret: "x".repeat(32),
});

describe("browser authentication mode", () => {
  it("keeps hosted deployments on magic links and scopes passwords to self-host", () => {
    expect(browserAuthenticationMode(requirements("preview"))).toBe(
      "magic-link",
    );
    expect(browserAuthenticationMode(requirements("staging"))).toBe(
      "magic-link",
    );
    expect(browserAuthenticationMode(requirements("selfhost"))).toBe(
      "email-password",
    );
    expect(
      browserAuthenticationMode(requirements("selfhost"), {
        DX_AUTH_EMAIL_FROM: "sign-in@example.com",
      }),
    ).toBe("magic-link");
  });

  it("opens self-host signup only for the exact enabled value", () => {
    expect(selfhostSignupEnabled({ DX_SIGNUP_ENABLED: "true" })).toBe(true);
    expect(selfhostSignupEnabled({ DX_SIGNUP_ENABLED: "false" })).toBe(false);
    expect(selfhostSignupEnabled({ DX_SIGNUP_ENABLED: undefined })).toBe(false);
  });

  it("enables reviewer passwords only for exact branch-preview and staging targets", () => {
    expect(
      reviewerPasswordEnabled(
        { DX_DEPLOYMENT_TARGET: "branch" },
        requirements("preview"),
      ),
    ).toBe(true);
    expect(
      reviewerPasswordEnabled(
        { DX_DEPLOYMENT_TARGET: "staging" },
        requirements("staging"),
      ),
    ).toBe(true);
    for (const [environment, target] of [
      ["preview", "staging"],
      ["staging", "branch"],
      ["production", "branch"],
      ["production", "staging"],
      ["preview", undefined],
    ] as const)
      expect(
        reviewerPasswordEnabled(
          { DX_DEPLOYMENT_TARGET: target },
          requirements(environment),
        ),
      ).toBe(false);
  });
});

describe("API key plugin contract", () => {
  it("exposes server API key endpoints directly on auth.api", async () => {
    const database = new Proxy(validD1Binding, {
      has: (target, property) =>
        property === "batch" || property === "exec" || property in target,
      get: (target, property, receiver) => {
        if (property === "batch" || property === "exec") {
          return () => {
            throw new Error("The API contract test must not query D1.");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const auth = createAuth(
      createTestBindings({ DB: database }),
      requirements("test"),
    );
    await auth.$context;

    expectTypeOf(auth.api.createApiKey).toBeFunction();
    expectTypeOf(auth.api.verifyApiKey).toBeFunction();
    expectTypeOf(auth.api.getApiKey).toBeFunction();
    expectTypeOf(auth.api.deleteApiKey).toBeFunction();
    expectTypeOf(auth.api.listApiKeys).toBeFunction();
    expect("apiKey" in auth.api).toBe(false);
    const endpointNames = [
      "createApiKey",
      "verifyApiKey",
      "getApiKey",
      "deleteApiKey",
      "listApiKeys",
    ] as const;
    expect(
      endpointNames.every(
        (endpoint) => typeof auth.api[endpoint] === "function",
      ),
    ).toBe(true);
  });
});
