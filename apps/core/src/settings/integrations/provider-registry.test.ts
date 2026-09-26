import type { ProviderRepositoryId } from "@dx/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestBindings,
  TEST_GITHUB_APP_CONFIGURATION,
} from "../../testing/bindings.js";
import {
  createOAuthProof,
  hashOAuthState,
  IntegrationProviderRequestFailed,
  loadIntegrationProviderRegistry,
} from "./provider-registry.js";

const callback = "https://dx.test/v1/integrations/github/oauth/callback";
const legacyCallback =
  "https://dx.test/v1/settings/personal/integrations/oauth/callback/github";

const githubConfig = (callbackUrl = callback) =>
  JSON.stringify({ ...JSON.parse(TEST_GITHUB_APP_CONFIGURATION), callbackUrl });

const githubPermissions = {
  actions: "write",
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  organization_projects: "write",
  pull_requests: "write",
  statuses: "read",
  workflows: "write",
};

afterEach(() => vi.restoreAllMocks());

describe("integration provider registry", () => {
  it("creates deterministic high-entropy state and an S256 PKCE challenge", async () => {
    const proof = await createOAuthProof({
      stateBytes: new Uint8Array(32).fill(7),
      verifierBytes: new Uint8Array(64).fill(9),
    });
    expect(proof.state).toHaveLength(43);
    expect(proof.codeVerifier).toHaveLength(86);
    expect(proof.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(proof.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await hashOAuthState(proof.state)).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashOAuthState(proof.state)).not.toBe(proof.state);
  });

  it("publishes only GitHub even when unsupported providers are configured", () => {
    const registry = loadIntegrationProviderRegistry(
      createTestBindings({
        DX_INTEGRATION_GITHUB_APP: githubConfig(),
        DX_INTEGRATION_GITLAB_OAUTH: JSON.stringify({
          clientId: "gitlab-client",
          clientSecret: "gitlab-secret",
          callbackUrl:
            "https://dx.test/v1/settings/personal/integrations/oauth/callback/gitlab",
          baseUrl: "https://gitlab.test",
        }),
        DX_INTEGRATION_FORGEJO_OAUTH: JSON.stringify({
          clientId: "forgejo-client",
        }),
      }),
      vi.fn<typeof fetch>(),
    );
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      provider: "github",
      available: true,
    });
    const authorizationUrl = new URL(
      registry[0]?.client?.authorizationUrl({
        state: "state",
        codeChallenge: "challenge",
      }) ?? "",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      legacyCallback,
    );
  });

  it("keeps GitHub visible but unavailable for rejected deployment config", () => {
    const registry = loadIntegrationProviderRegistry(
      createTestBindings({
        DX_INTEGRATION_GITHUB_APP: githubConfig(
          "https://dx.test/not-the-callback",
        ),
      }),
      vi.fn<typeof fetch>(),
    );
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      provider: "github",
      configured: true,
      available: false,
    });
  });

  it("rejects repository responses outside the GitHub App contract", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.github.com/user/installations?per_page=100") {
        return Response.json({
          installations: [
            {
              id: 1,
              account: { type: "Organization" },
              permissions: githubPermissions,
            },
          ],
        });
      }
      if (
        url ===
        "https://api.github.com/user/installations/1/repositories?per_page=100"
      ) {
        return Response.json({
          repositories: [
            {
              id: 71,
              full_name: "fake/repository",
              html_url: "javascript:alert(1)",
              clone_url: "https://github.com/fake/repository.git",
              private: true,
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    const client = loadIntegrationProviderRegistry(
      createTestBindings({ DX_INTEGRATION_GITHUB_APP: githubConfig() }),
      fakeFetch,
    )[0]?.client;
    if (client === undefined) throw new Error("Expected GitHub client.");
    await expect(client.repositories("fake-token")).rejects.toBeInstanceOf(
      IntegrationProviderRequestFailed,
    );
  });

  it("decodes valid GitHub repositories", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/user/installations?per_page=100")) {
        return Response.json({
          installations: [
            {
              id: 1,
              account: { type: "Organization" },
              permissions: githubPermissions,
            },
          ],
        });
      }
      return Response.json({
        repositories: [
          {
            id: 71,
            full_name: "fake/repository",
            html_url: "https://github.com/fake/repository",
            clone_url: "https://github.com/fake/repository.git",
            private: true,
          },
        ],
      });
    });
    const client = loadIntegrationProviderRegistry(
      createTestBindings({ DX_INTEGRATION_GITHUB_APP: githubConfig() }),
      fakeFetch,
    )[0]?.client;
    await expect(client?.repositories("fake-token")).resolves.toEqual([
      {
        id: "71" as ProviderRepositoryId,
        fullName: "fake/repository",
        webUrl: "https://github.com/fake/repository",
        cloneUrl: "https://github.com/fake/repository.git",
        visibility: "private",
      },
    ]);
  });

  it("accepts the repository-only permission envelope for user installations", async () => {
    const { organization_projects: _organizationProjects, ...userPermissions } =
      githubPermissions;
    const fakeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/user/installations?per_page=100")) {
        return Response.json({
          installations: [
            {
              id: 2,
              account: { type: "User" },
              permissions: userPermissions,
            },
          ],
        });
      }
      return Response.json({ repositories: [] });
    });
    const client = loadIntegrationProviderRegistry(
      createTestBindings({ DX_INTEGRATION_GITHUB_APP: githubConfig() }),
      fakeFetch,
    )[0]?.client;

    await expect(client?.repositories("fake-token")).resolves.toEqual([]);
  });
});
