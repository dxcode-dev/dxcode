import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createTestBindings } from "../testing/bindings.js";
import { loadAuthenticationRequirements } from "./requirements.js";

const failure = (overrides: Parameters<typeof createTestBindings>[0]) =>
  Effect.runPromise(
    Effect.flip(loadAuthenticationRequirements(createTestBindings(overrides))),
  );

describe("authentication requirements", () => {
  it("loads explicit origins and secret", async () => {
    const requirements = await Effect.runPromise(
      loadAuthenticationRequirements(createTestBindings()),
    );
    expect(requirements).toMatchObject({
      authUrl: "https://dx.test",
      trustedOrigins: ["https://dx.test"],
    });
    expect(requirements.secret.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects missing, short, and insecure deployed configuration", async () => {
    const missingSecret = createTestBindings();
    Reflect.deleteProperty(missingSecret, "BETTER_AUTH_SECRET");
    await expect(
      Effect.runPromise(
        Effect.flip(loadAuthenticationRequirements(missingSecret)),
      ),
    ).resolves.toMatchObject({
      _tag: "AuthenticationConfigurationError",
      reason: "missing_configuration",
    });
    await expect(
      failure({ BETTER_AUTH_SECRET: "short" }),
    ).resolves.toMatchObject({
      _tag: "AuthenticationConfigurationError",
      reason: "secret_too_short",
    });
    await expect(
      failure({ DX_AUTH_URL: "http://dx.test" }),
    ).resolves.toMatchObject({
      _tag: "AuthenticationConfigurationError",
      reason: "deployed_requires_https",
    });
  });

  it("reports which URL failed to parse", async () => {
    await expect(failure({ DX_AUTH_URL: "not a url" })).resolves.toMatchObject({
      reason: "invalid_auth_url",
    });
    await expect(
      failure({ DX_AUTH_TRUSTED_ORIGINS: "https://dx.test,nope" }),
    ).resolves.toMatchObject({ reason: "invalid_trusted_origin" });
  });

  it("allows localhost HTTP authentication only in local mode", async () => {
    const requirements = await Effect.runPromise(
      loadAuthenticationRequirements(
        createTestBindings({
          DX_ENV: "local",
          DX_AUTH_URL: "http://localhost:3000",
          DX_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
        }),
      ),
    );
    expect(requirements.environment).toBe("local");
    await expect(
      failure({
        DX_ENV: "local",
        DX_AUTH_URL: "https://dx.example.com",
      }),
    ).resolves.toMatchObject({
      _tag: "AuthenticationConfigurationError",
      reason: "local_requires_localhost",
    });
  });
});
