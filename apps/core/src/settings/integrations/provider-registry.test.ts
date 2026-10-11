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
});
