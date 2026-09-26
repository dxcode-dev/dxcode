import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeGitHubAppDeploymentConfiguration } from "./github-app-configuration.js";

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
