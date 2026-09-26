import { Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createGitHubProvider, GitHubProviderError } from "./provider-http.js";
import { githubPermissionsForOperation } from "./runtime-adapter.js";

const config = {
  clientId: "Iv1.test",
  clientSecret: Redacted.make("secret"),
  callbackUrl: "https://dx.example/v1/integrations/github/oauth/callback",
} as never;
const installation = (id: number) => ({
  id,
  account: { id: id + 10, login: `owner-${id}`, type: "Organization" },
  repository_selection: "selected",
  permissions: { contents: "write" },
  suspended_at: null,
});
const repository = (id: number) => ({
  id,
  full_name: `o/r${id}`,
  html_url: `https://github.com/o/r${id}`,
  clone_url: `https://github.com/o/r${id}.git`,
  visibility: "private",
  archived: false,
  default_branch: "main",
});
const response = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), init);

describe("GitHub provider HTTP boundary", () => {
  it.each([
    ["provider-auth-read", { metadata: "read" }],
    [
      "checks-status-read",
      {
        checks: "read",
        metadata: "read",
        pull_requests: "read",
        statuses: "read",
      },
    ],
  ] as const)(
    "mints the exact %s installation-token payload",
    async (operation, expected) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
        response({
          token: "short-lived",
          expires_at: "2026-08-25T21:00:00Z",
        }),
      );
      await createGitHubProvider(config, fetcher).createInstallationToken(
        "app-jwt",
        "9",
        {
          repositoryId: "42",
          permissions: githubPermissionsForOperation(operation),
        },
      );
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
        repository_ids: [42],
        permissions: expected,
      });
    },
  );

  it("mints a one-repository read lease and resolves an exact default-branch tip", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ token: "short-lived", expires_at: "2026-08-25T21:00:00Z" }),
      )
      .mockResolvedValueOnce(response(repository(42)))
      .mockResolvedValueOnce(response({ sha: "a".repeat(40) }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const provider = createGitHubProvider(config, fetcher);
    const lease = await provider.createInstallationToken("app-jwt", "9", {
      repositoryId: "42",
      permissions: { contents: "read", metadata: "read" },
    });
    const source = await provider.resolveRepositorySource(lease.token, "42");
    await provider.revokeInstallationToken(lease.token);

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      repository_ids: [42],
      permissions: { contents: "read", metadata: "read" },
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/app/installations/9/access_tokens",
      "https://api.github.com/repositories/42",
      "https://api.github.com/repositories/42/commits/main",
      "https://api.github.com/installation/token",
    ]);
    expect(source).toMatchObject({
      repository: { id: "42", cloneUrl: "https://github.com/o/r42.git" },
      commitSha: "a".repeat(40),
    });
  });

  it.each([1, 2, 101])(
    "paginates and deduplicates %i installations",
    async (count) => {
      const first = Array.from({ length: Math.min(count, 100) }, (_, index) =>
        installation(index + 1),
      );
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
        response(
          { installations: first },
          count > 100
            ? {
                headers: {
                  link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
                },
              }
            : {},
        ),
      );
      if (count > 100)
        fetcher.mockResolvedValueOnce(
          response({ installations: [installation(100), installation(101)] }),
        );
      const result = await createGitHubProvider(
        config,
        fetcher,
      ).listUserInstallations("token");
      expect(result).toHaveLength(count);
      expect(fetcher).toHaveBeenCalledTimes(count > 100 ? 2 : 1);
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    },
  );

  it("rejects unsafe and cyclic pagination links", async () => {
    for (const link of [
      '<http://api.github.com/user/installations?page=2>; rel="next"',
      '<https://evil.example/x>; rel="next"',
      '<https://api.github.com/user/installations?per_page=100>; rel="next"',
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response({ installations: [] }, { headers: { link } }),
        );
      await expect(
        createGitHubProvider(config, fetcher).listUserInstallations("token"),
      ).rejects.toMatchObject({ category: "invalid-response" });
    }
  });

  it("paginates and deduplicates more than 100 installation repositories", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          {
            repositories: Array.from({ length: 100 }, (_, index) =>
              repository(index + 1),
            ),
          },
          {
            headers: {
              link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        response({ repositories: [repository(100), repository(101)] }),
      );
    const repositories = await createGitHubProvider(
      config,
      fetcher,
    ).listInstallationRepositories("installation-token");
    expect(repositories).toHaveLength(101);
    expect(repositories.at(-1)?.id).toBe("101");
  });

  it.each([
    [401, {}, "unauthorized"],
    [403, {}, "forbidden"],
    [403, { "x-github-sso": "required" }, "saml-required"],
    [404, {}, "not-found"],
  ] as const)("maps status %i", async (status, headers, category) => {
    const provider = createGitHubProvider(
      config,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status, headers })),
    );
    await expect(provider.getUser("sensitive-token")).rejects.toMatchObject({
      category,
    });
  });

  it("parses retry headers using the injected clock", async () => {
    const provider = createGitHubProvider(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("", {
          status: 429,
          headers: { "retry-after": "7", "x-ratelimit-reset": "1" },
        }),
      ),
      () => new Date("2026-01-01T00:00:00Z"),
    );
    await expect(provider.getUser("token")).rejects.toMatchObject({
      category: "rate-limited",
      retryAt: new Date("2026-01-01T00:00:07Z"),
    });
  });

  it("validates payload and repository URLs", async () => {
    const malformed = createGitHubProvider(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json")),
    );
    await expect(malformed.getUser("token")).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
    const unsafe = createGitHubProvider(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        response({
          repositories: [
            { ...repository(1), html_url: "https://evil.example/o/r" },
          ],
        }),
      ),
    );
    await expect(
      unsafe.listInstallationRepositories("installation-token"),
    ).rejects.toMatchObject({ category: "invalid-response" });
  });

  it("exchanges, refreshes, and revokes without changing HTTP contracts", async () => {
    const tokenBody = {
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      refresh_token_expires_in: 7200,
      scope: "repo user",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(tokenBody))
      .mockResolvedValueOnce(response(tokenBody))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const provider = createGitHubProvider(config, fetcher, () => new Date(0));
    expect(await provider.exchangeCode("code", "verifier")).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(3_600_000),
    });
    await provider.refresh("refresh");
    await provider.revoke("access");
    expect(
      fetcher.mock.calls.map((call) => [
        call[0],
        call[1]?.method,
        call[1]?.redirect,
      ]),
    ).toEqual([
      ["https://github.com/login/oauth/access_token", "POST", "manual"],
      ["https://github.com/login/oauth/access_token", "POST", "manual"],
      [
        "https://api.github.com/applications/Iv1.test/token",
        "DELETE",
        "manual",
      ],
    ]);
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain(
      "grant_type=refresh_token",
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ "user-agent": "dx-github-app" }),
    );
  });

  it("identifies dx on GitHub REST API requests", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: 84, login: "dx-user" }));
    const provider = createGitHubProvider(config, fetcher);

    await provider.getUser("token");

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ "user-agent": "dx-github-app" }),
      }),
    );
  });

  it("deletes an installation with App authority and treats absence as success", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const provider = createGitHubProvider(config, fetcher);

    await provider.deleteInstallation("app-jwt", "9");
    await provider.deleteInstallation("app-jwt", "9");

    expect(fetcher.mock.calls).toEqual([
      [
        "https://api.github.com/app/installations/9",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ authorization: "Bearer app-jwt" }),
          redirect: "manual",
        }),
      ],
      [
        "https://api.github.com/app/installations/9",
        expect.objectContaining({ method: "DELETE", redirect: "manual" }),
      ],
    ]);
  });
});
