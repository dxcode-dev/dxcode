import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeGitHubAppDeploymentConfiguration,
  GitHubAppConfigurationInvalid,
} from "./github-app-configuration.js";
import {
  signGitHubAppRelayState,
  verifyGitHubAppRelayState,
} from "./github-app-relay.js";

const origin = "https://dx.test";
const valid = () => ({
  version: 1,
  appId: "12345",
  appSlug: "dx-test",
  clientId: "Iv1.client",
  clientSecret: "client-secret-value",
  privateKeyPem: [
    "-----BEGIN RSA PRIVATE KEY-----",
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    "-----END RSA PRIVATE KEY-----",
  ].join("\r\n"),
  webhookSecret: "webhook-secret-value",
  callbackUrl: `${origin}/v1/integrations/github/oauth/callback`,
  setupUrl: `${origin}/v1/integrations/github/setup`,
  webhookUrl: `${origin}/v1/integrations/github/webhooks`,
  expiringUserTokens: true,
  permissionManifestVersion: 1,
  repositoryPermissions: {
    actions: "write",
    checks: "read",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "read",
    workflows: "write",
  },
  organizationPermissions: { projects: "write" },
  events: ["repository"],
});

const decode = (input: unknown) =>
  Effect.runPromise(
    decodeGitHubAppDeploymentConfiguration(input, origin, "test"),
  );

describe("GitHub App deployment configuration", () => {
  it("accepts only the exact manifest and normalizes PEM", async () => {
    const configuration = await decode(valid());
    expect(configuration.privateKeyPem).not.toContain("\r");
    expect(configuration.privateKeyPem.endsWith("\n")).toBe(true);
    expect(configuration.organizationPermissions).toEqual({
      projects: "write",
    });
  });

  it.each([
    ["missing key", ({ webhookSecret: _, ...rest }) => rest],
    ["unknown key", (input) => ({ ...input, unknown: true })],
    ["URL drift", (input) => ({ ...input, setupUrl: `${origin}/wrong` })],
    [
      "permission drift",
      (input) => ({
        ...input,
        repositoryPermissions: {
          ...input.repositoryPermissions,
          contents: "read",
        },
      }),
    ],
    ["event drift", (input) => ({ ...input, events: ["push"] })],
    [
      "mismatched PEM boundaries",
      (input) => ({
        ...input,
        privateKeyPem: input.privateKeyPem.replace(
          "END RSA PRIVATE KEY",
          "END PRIVATE KEY",
        ),
      }),
    ],
  ] as const)(
    "rejects %s without exposing configuration",
    async (_name, mutate) => {
      const input = valid();
      const result = await Effect.runPromise(
        Effect.flip(
          decodeGitHubAppDeploymentConfiguration(mutate(input), origin, "test"),
        ),
      );
      expect(result._tag).toBe("GitHubAppConfigurationInvalid");
      expect(String(result)).not.toContain(input.clientSecret);
      expect(String(result)).not.toContain(input.webhookSecret);
    },
  );
});

describe("GitHub App relay for branch previews", () => {
  const preview = "https://dx-feature-0123abcd.preview.test";
  const relay = "https://relay.preview.test";
  const relayed = () => ({
    ...valid(),
    callbackUrl: `${relay}/v1/integrations/github/oauth/callback`,
    setupUrl: `${relay}/v1/integrations/github/setup`,
    webhookUrl: `${relay}/v1/integrations/github/webhooks`,
  });

  it("accepts one relay origin on a branch preview", async () => {
    const configuration = await Effect.runPromise(
      decodeGitHubAppDeploymentConfiguration(
        relayed(),
        preview,
        "preview",
        "branch",
      ),
    );
    expect(configuration.relayOrigin).toBe(relay);
    const direct = await Effect.runPromise(
      decodeGitHubAppDeploymentConfiguration(
        {
          ...valid(),
          callbackUrl: `${preview}/v1/integrations/github/oauth/callback`,
          setupUrl: `${preview}/v1/integrations/github/setup`,
          webhookUrl: `${preview}/v1/integrations/github/webhooks`,
        },
        preview,
        "preview",
        "branch",
      ),
    );
    expect(direct.relayOrigin).toBeUndefined();
  });

  it.each([
    ["staging", "staging"],
    ["selfhost", "selfhost"],
    ["production", undefined],
    ["local", undefined],
    ["test", undefined],
    [undefined, undefined],
    // DX_ENV alone never makes a deployment a branch preview.
    ["preview", "staging"],
    ["preview", "selfhost"],
    ["preview", undefined],
    ["staging", "branch"],
  ])(
    "refuses relay URLs outside branch previews (DX_ENV %s, target %s)",
    async (environment, target) => {
      const result = await Effect.runPromise(
        Effect.flip(
          decodeGitHubAppDeploymentConfiguration(
            relayed(),
            preview,
            environment,
            target,
          ),
        ),
      );
      expect(result._tag).toBe("GitHubAppConfigurationInvalid");
    },
  );

  it.each([
    [
      "split origins",
      (input: ReturnType<typeof relayed>) => ({
        ...input,
        webhookUrl: `${preview}/v1/integrations/github/webhooks`,
      }),
    ],
    [
      "plain HTTP",
      (input: ReturnType<typeof relayed>) => ({
        ...input,
        callbackUrl: input.callbackUrl.replace("https:", "http:"),
        setupUrl: input.setupUrl.replace("https:", "http:"),
        webhookUrl: input.webhookUrl.replace("https:", "http:"),
      }),
    ],
    [
      "a relay path prefix",
      (input: ReturnType<typeof relayed>) => ({
        ...input,
        callbackUrl: `${relay}/x/v1/integrations/github/oauth/callback`,
      }),
    ],
  ] as const)("refuses %s on a preview", async (_name, mutate) => {
    const result = await Effect.runPromise(
      Effect.flip(
        decodeGitHubAppDeploymentConfiguration(
          mutate(relayed()),
          preview,
          "preview",
          "branch",
        ),
      ),
    );
    expect(result._tag).toBe("GitHubAppConfigurationInvalid");
  });
});

describe("GitHub App relay state", () => {
  const webhookSecret = "webhook-secret-value";
  const host = "dx-feature-0123abcd.preview.test";
  const now = new Date("2026-11-01T00:00:00Z");
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  const verify = (state: string, overrides = {}) =>
    verifyGitHubAppRelayState({
      webhookSecret,
      state,
      now,
      maxLifetimeMs: 60 * 60_000,
      ...overrides,
    });

  it("names the signing preview's host until it expires", async () => {
    const state = await signGitHubAppRelayState({
      webhookSecret,
      host,
      expiresAt,
    });
    // Core bounds the state GitHub returns to 128 characters.
    expect(state.length).toBeLessThanOrEqual(128);
    expect(await verify(state)).toEqual({
      host,
      expiresAt: new Date(Math.floor(expiresAt.getTime() / 1_000) * 1_000),
    });
    expect(
      await signGitHubAppRelayState({ webhookSecret, host, expiresAt }),
    ).not.toBe(state);
  });

  it("refuses a state signed with another key, tampered, or out of time", async () => {
    const state = await signGitHubAppRelayState({
      webhookSecret,
      host,
      expiresAt,
    });
    const parts = state.split(".");
    const forged = [...parts.slice(0, 4), "dx-staging", "preview", "test"];
    for (const candidate of [
      await signGitHubAppRelayState({
        webhookSecret: "another-secret-value",
        host,
        expiresAt,
      }),
      forged.join("."),
      [
        parts[0],
        parts[1],
        (Number.parseInt(parts[2] as string, 36) + 1).toString(36),
        ...parts.slice(3),
      ].join("."),
      state.replace(/^r1\./, "r2."),
      `${state}.`,
      "",
    ])
      expect(await verify(candidate)).toBeUndefined();
    expect(
      await verify(state, { now: new Date(expiresAt.getTime() + 1_000) }),
    ).toBeUndefined();
    expect(await verify(state, { maxLifetimeMs: 60_000 })).toBeUndefined();
  });

  it("refuses to sign for a host a relay could not route", async () => {
    for (const bad of [
      "",
      "localhost:8787",
      `${"a".repeat(60)}.preview.test`,
      "Dx.Test",
    ])
      await expect(
        signGitHubAppRelayState({ webhookSecret, host: bad, expiresAt }),
      ).rejects.toBeInstanceOf(GitHubAppConfigurationInvalid);
  });
});
