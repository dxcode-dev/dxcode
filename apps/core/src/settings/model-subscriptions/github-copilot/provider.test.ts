import { describe, expect, it, vi } from "vitest";
import {
  CopilotError,
  createGitHubCopilotProvider,
  parseActiveModels,
} from "./provider.js";

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const access = {
  accessToken: "opaque-copilot-token",
  expiresAt: 2_000_000,
  apiOrigin: "https://api.githubcopilot.com",
};
const entitlements = (modelId: string) => ({
  enabledModelIds: [modelId],
  catalogRevision: "test:catalog",
  observedAt: 0,
});

describe("GitHub Copilot provider", () => {
  it.each([
    ["authorization_pending", "pending"],
    ["slow_down", "slow_down"],
    ["access_denied", "denied"],
    ["expired_token", "expired"],
  ] as const)("maps device flow %s", async (error, expected) => {
    const provider = createGitHubCopilotProvider({
      clientId: "dx-owned-client",
      clock: () => 10_000,
      fetch: vi.fn().mockResolvedValue(response({ error })),
    });
    await expect(
      provider.pollDeviceAuthorization({
        deviceCode: "secret",
        userCode: "CODE",
        verificationUri: "https://github.com/login/device",
        expiresAt: 20_000,
        intervalSeconds: 5,
        nextPollAt: 10_000,
      }),
    ).resolves.toMatchObject({ status: expected });
  });

  it("requires the exact verification URI", async () => {
    const provider = createGitHubCopilotProvider({
      clientId: "dx-owned-client",
      fetch: vi.fn().mockResolvedValue(
        response({
          device_code: "secret",
          user_code: "CODE",
          verification_uri: "https://evil.test/login/device",
          expires_in: 60,
        }),
      ),
    });
    await expect(provider.startDeviceAuthorization()).rejects.toMatchObject({
      code: "UNTRUSTED_VERIFICATION_URI",
    });
  });

  it("prefers explicit policy and fails closed on incompatible model metadata", () => {
    expect(
      parseActiveModels({
        data: [
          {
            id: "gpt-5-mini",
            policy: { state: "enabled" },
            model_picker_enabled: false,
          },
          {
            id: "gpt-4.1",
            model_picker_enabled: true,
            supported_endpoints: ["/wrong"],
          },
          {
            id: "claude-sonnet-4.5",
            policy: { state: "disabled" },
            model_picker_enabled: true,
          },
          {
            id: "claude-opus-5",
            policy: { state: "enabled" },
            capabilities: { supports: { tool_calls: false } },
          },
          { id: "unknown-secret-id", policy: { state: "enabled" } },
        ],
      }),
    ).toEqual(["gpt-5-mini"]);
  });

  it("skips malformed model items without hiding later valid models", () => {
    expect(
      parseActiveModels({
        data: [
          null,
          { id: 42, policy: { state: "enabled" } },
          { id: "gpt-4.1", policy: "enabled" },
          {
            id: "gpt-5-mini",
            policy: { state: "enabled" },
          },
        ],
      }),
    ).toEqual(["gpt-5-mini"]);
  });

  it.each([
    {
      ...access,
      apiOrigin: "https://untrusted.example",
    },
    {
      ...access,
      expiresAt: 1_000_000,
    },
  ])(
    "rejects invalid discovery access before sending credentials",
    async (input) => {
      const fetcher = vi.fn();
      const provider = createGitHubCopilotProvider({
        clientId: "dx-owned-client",
        clock: () => 1_000_000,
        fetch: fetcher,
      });

      await expect(provider.discoverModels(input)).rejects.toMatchObject({
        code: "ACCESS_INVALID",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("uses the dedicated OAuth token directly without a token exchange", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 42, login: "octo" }));
    const provider = createGitHubCopilotProvider({
      clientId: "dx-owned-client",
      clock: () => 1_000_000,
      fetch: fetcher,
    });
    await expect(provider.getGitHubIdentity("github-token")).resolves.toEqual({
      id: "42",
      login: "octo",
    });
    await expect(
      provider.resolveCopilotAccess({ accessToken: "github-token" }),
    ).resolves.toMatchObject({
      credential: { accessToken: "github-token" },
      access: {
        accessToken: "github-token",
        apiOrigin: "https://api.githubcopilot.com",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer github-token",
    });
  });

  it("rotates an expiring device credential without a client secret", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response({
        access_token: "next-access",
        expires_in: 28_800,
        refresh_token: "next-refresh",
        refresh_token_expires_in: 15_897_600,
      }),
    );
    const provider = createGitHubCopilotProvider({
      clientId: "dx-owned-client",
      clock: () => 1_000_000,
      fetch: fetcher,
    });
    const resolved = await provider.resolveCopilotAccess({
      accessToken: "old-access",
      expiresAt: 1_030_000,
      refreshToken: "old-refresh",
      refreshExpiresAt: 2_000_000,
    });
    expect(resolved.credential.accessToken).toBe("next-access");
    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");
    expect(body).not.toContain("client_secret");
  });

  it.each([
    ["gpt-5-mini", "/responses"],
    ["gpt-4.1", "/chat/completions"],
    ["claude-sonnet-4.5", "/v1/messages"],
  ])(
    "dispatches %s to its reviewed protocol and streams",
    async (modelId, endpoint) => {
      const fetcher = vi.fn().mockResolvedValue(new Response("data: {}\n\n"));
      const provider = createGitHubCopilotProvider({
        clientId: "dx-owned-client",
        clock: () => 1_000_000,
        fetch: fetcher,
      });
      const result = await provider.invoke({
        modelId,
        access,
        entitlements: entitlements(modelId),
        payload: { messages: [] },
      });
      await expect(result.text()).resolves.toBe("data: {}\n\n");
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        `https://api.githubcopilot.com${endpoint}`,
      );
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        redirect: "manual",
        headers: expect.objectContaining({
          authorization: "Bearer opaque-copilot-token",
        }),
      });
    },
  );

  it("keeps the timeout active until the response stream ends", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("upstream aborted")),
                  { once: true },
                );
              },
            }),
          ),
      );
      const provider = createGitHubCopilotProvider({
        clientId: "dx-owned-client",
        clock: () => 1_000_000,
        fetch: fetcher,
        timeoutMs: 100,
      });
      const result = await provider.invoke({
        modelId: "gpt-5-mini",
        access,
        entitlements: entitlements("gpt-5-mini"),
        payload: { input: [] },
      });

      const body = result.text().then(
        () => ({ code: "STREAM_COMPLETED" }),
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(body).resolves.toMatchObject({ code: "TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks redirects and keeps errors secret-free", async () => {
    const provider = createGitHubCopilotProvider({
      clientId: "dx-owned-client",
      clock: () => 1_000_000,
      fetch: vi
        .fn()
        .mockResolvedValue(response({ token: "secret-fragment" }, 302)),
    });
    const error = await provider
      .getGitHubIdentity("github-super-secret")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CopilotError);
    expect(JSON.stringify(error)).not.toMatch(/super-secret|secret-fragment/);
  });

  it.each([
    "http://api.githubcopilot.com",
    "https://api.githubcopilot.com/path",
    "https://user@api.githubcopilot.com",
  ])("rejects a non-root HTTPS API origin: %s", (origin) => {
    expect(() =>
      createGitHubCopilotProvider({
        clientId: "dx-owned-client",
        allowedApiOrigins: [origin],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_API_ORIGIN" }));
  });
});
