import { Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  BitbucketProviderError,
  createBitbucketProvider,
} from "./provider-http.js";

const workspaceId = "{11111111-1111-4111-8111-111111111111}";
const repositoryId = "{22222222-2222-4222-8222-222222222222}";
const config = {
  clientId: "client",
  clientSecret: Redacted.make("super-secret"),
  callbackUrl: "https://dx.example/bitbucket/callback",
};
const response = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), init);
const repository = (suffix = "repo") => ({
  uuid: repositoryId,
  workspace: { uuid: workspaceId },
  full_name: `space/${suffix}`,
  scm: "git",
  is_private: true,
  mainbranch: { name: "main" },
  links: {
    html: { href: `https://bitbucket.org/space/${suffix}` },
    clone: [
      {
        name: "https",
        href: `https://oauth-user@bitbucket.org/space/${suffix}.git`,
      },
    ],
  },
});
describe("Bitbucket provider HTTP boundary", () => {
  it("accepts mixed-case repository links with normalized identity", async () => {
    const data = repository("Repo");
    const provider = createBitbucketProvider(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(response(data)),
    );
    expect(
      await provider.getRepository("token", "space", "repo"),
    ).toMatchObject({ id: repositoryId, workspaceId });
  });

  it("exchanges and refreshes rotating OAuth tokens without leaking credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 7200,
          token_type: "bearer",
          scopes: "pullrequest repository",
        }),
      )
      .mockResolvedValueOnce(
        response({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "repository account",
        }),
      );
    const provider = createBitbucketProvider(
      config,
      fetcher,
      () => new Date(0),
    );
    expect(await provider.exchangeCode("one-time-code")).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date(7_200_000),
      scopes: ["pullrequest", "repository"],
    });
    expect(await provider.refreshToken("refresh-1")).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: new Date(3_600_000),
      scopes: ["account", "repository"],
    });
    expect(
      fetcher.mock.calls.map(([url, init]) => [
        url,
        init?.method,
        init?.redirect,
      ]),
    ).toEqual([
      ["https://bitbucket.org/site/oauth2/access_token", "POST", "manual"],
      ["https://bitbucket.org/site/oauth2/access_token", "POST", "manual"],
    ]);
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain(
      "refresh_token=refresh-1",
    );
    await expect(
      createBitbucketProvider(
        config,
        vi
          .fn<typeof fetch>()
          .mockRejectedValue(new Error("super-secret access-1")),
      ).getUser("access-1"),
    ).rejects.toEqual(new BitbucketProviderError({ category: "unavailable" }));
  });

  it("normalizes users, repositories, and source commits", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ uuid: workspaceId, nickname: "octo" }))
      .mockResolvedValueOnce(response(repository()))
      .mockResolvedValueOnce(response(repository()))
      .mockResolvedValueOnce(response({ values: [{ hash: "a".repeat(40) }] }));
    const provider = createBitbucketProvider(config, fetcher);
    expect(await provider.getUser("token")).toEqual({
      id: workspaceId,
      login: "octo",
    });
    expect(
      await provider.getRepository("token", "space", "repo"),
    ).toMatchObject({
      id: repositoryId,
      workspaceId,
      visibility: "private",
      archived: false,
    });
    expect(
      (await provider.resolveRepositorySource("token", "space", "repo"))
        .commitSha,
    ).toBe("a".repeat(40));
    expect(
      fetcher.mock.calls.every(
        ([, init]) =>
          init?.redirect === "manual" && init?.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  });

  it("fully paginates permission repositories while deduplicating", async () => {
    const secondRepository = {
      ...repository("two"),
      uuid: "{33333333-3333-4333-8333-333333333333}",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          values: [
            {
              type: "workspace_membership",
              administrator: false,
              workspace: {
                type: "workspace",
                uuid: workspaceId,
                slug: "space",
              },
            },
          ],
          next: "https://api.bitbucket.org/2.0/user/workspaces?page=2",
        }),
      )
      .mockResolvedValueOnce(
        response({
          values: [
            {
              type: "workspace_membership",
              administrator: true,
              workspace: {
                type: "workspace",
                uuid: "{44444444-4444-4444-8444-444444444444}",
                slug: "unrelated-team",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          values: [
            {
              permission: "write",
              repository: {
                type: "repository",
                name: "repo",
                full_name: "space/repo",
                uuid: repositoryId,
              },
            },
            {
              permission: "admin",
              repository: {
                type: "repository",
                name: "two",
                full_name: "space/two",
                uuid: secondRepository.uuid,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(response(repository()))
      .mockResolvedValueOnce(response(secondRepository));
    const provider = createBitbucketProvider(config, fetcher);
    expect(
      (await provider.listRepositories("token")).map((item) => item.fullName),
    ).toEqual(["space/repo", "space/two"]);
    expect(fetcher.mock.calls[4]?.[0]).toBe(
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspaceId)}/${encodeURIComponent(repositoryId)}`,
    );
  });

  it("hydrates repositories four at a time and preserves discovery order", async () => {
    const repositories = Array.from({ length: 9 }, (_, index) => ({
      ...repository(`repo-${index}`),
      uuid: `{22222222-2222-4222-8222-${String(index).padStart(12, "0")}}`,
    }));
    let active = 0;
    let peak = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ values: [{ workspace: { uuid: workspaceId } }] }),
      )
      .mockResolvedValueOnce(
        response({
          values: repositories.map((item) => ({
            permission: "read",
            repository: { ...item, type: "repository" },
          })),
        }),
      )
      .mockImplementation(async (input) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        const id = decodeURIComponent(
          new URL(String(input)).pathname.split("/").at(-1) ?? "",
        );
        return response(repositories.find((item) => item.uuid === id));
      });
    const result = await createBitbucketProvider(
      config,
      fetcher,
    ).listRepositories("token");
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(result.map((item) => item.id)).toEqual(
      repositories.map((item) => item.uuid),
    );
    expect(fetcher).toHaveBeenCalledTimes(11);
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate-limited"],
    [500, "unavailable"],
  ])("preserves hydration failure %i as %s", async (status, category) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ values: [{ workspace: { uuid: workspaceId } }] }),
      )
      .mockResolvedValueOnce(
        response({
          values: [
            {
              permission: "read",
              repository: { ...repository(), type: "repository" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: Number(status) }));
    await expect(
      createBitbucketProvider(config, fetcher).listRepositories("token"),
    ).rejects.toMatchObject({ category });
  });

  it.each([
    "http://api.bitbucket.org/x",
    "https://evil.example/x",
    "https://user:pass@api.bitbucket.org/x",
  ])("rejects unsafe next link %s", async (next) => {
    const provider = createBitbucketProvider(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(response({ values: [], next })),
    );
    await expect(provider.listRepositories("token")).rejects.toMatchObject({
      category: "invalid-response",
    });
  });

  it.each([
    null,
    { uuid: workspaceId },
    { workspace: null },
    { workspace: "invalid" },
    { workspace: {} },
    { workspace: { uuid: "invalid" } },
  ])("rejects malformed workspace membership %j", async (membership) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ values: [membership] }));
    await expect(
      createBitbucketProvider(config, fetcher).listRepositories("token"),
    ).rejects.toMatchObject({ category: "invalid-response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects cyclic pagination", async () => {
    const first = "https://api.bitbucket.org/2.0/user/workspaces?pagelen=100";
    const provider = createBitbucketProvider(
      config,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ values: [], next: first })),
    );
    await expect(provider.listRepositories("token")).rejects.toMatchObject({
      category: "invalid-response",
    });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not-found"],
    [500, "unavailable"],
  ] as const)("maps status %i to %s", async (status, category) => {
    const provider = createBitbucketProvider(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status })),
    );
    await expect(provider.getUser("token")).rejects.toMatchObject({ category });
  });

  it("maps OAuth errors distinctly and parses rate limits", async () => {
    await expect(
      createBitbucketProvider(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("", { status: 401 })),
      ).refreshToken("old"),
    ).rejects.toMatchObject({ category: "unauthorized" });
    await expect(
      createBitbucketProvider(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response(
              { error: "invalid_grant", error_description: "expired" },
              { status: 400 },
            ),
          ),
      ).refreshToken("old"),
    ).rejects.toMatchObject({ category: "invalid-grant" });
    await expect(
      createBitbucketProvider(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response({ error: "invalid_client" }, { status: 400 }),
          ),
      ).refreshToken("old"),
    ).rejects.toMatchObject({ category: "invalid-response" });
    const provider = createBitbucketProvider(
      config,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("", { status: 429, headers: { "retry-after": "9" } }),
        ),
      () => new Date(0),
    );
    await expect(provider.getUser("token")).rejects.toMatchObject({
      category: "rate-limited",
      retryAt: new Date(9_000),
    });
  });

  it("rejects malformed payloads, unsafe URLs, missing branches, empty repositories, and redirects", async () => {
    await expect(
      createBitbucketProvider(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(response({ uuid: "bad", nickname: "user" })),
      ).getUser("token"),
    ).rejects.toMatchObject({ category: "invalid-response" });
    await expect(
      createBitbucketProvider(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(
          response({
            ...repository(),
            links: {
              ...repository().links,
              html: { href: "https://evil.example/repo" },
            },
          }),
        ),
      ).getRepository("token", "space", "repo"),
    ).rejects.toMatchObject({ category: "invalid-response" });
    await expect(
      createBitbucketProvider(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/token" },
          }),
        ),
      ).getUser("token"),
    ).rejects.toMatchObject({ category: "invalid-response" });
    await expect(
      createBitbucketProvider(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(response({ ...repository(), mainbranch: null })),
      ).getRepository("token", "space", "repo"),
    ).rejects.toMatchObject({ category: "invalid-response" });
    const empty = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(repository()))
      .mockResolvedValueOnce(response({ values: [] }));
    await expect(
      createBitbucketProvider(config, empty).resolveRepositorySource(
        "token",
        "space",
        "repo",
      ),
    ).rejects.toMatchObject({ category: "invalid-response" });
  });

  it("excludes empty and deleted repositories without hiding healthy repositories", async () => {
    const emptyId = "{55555555-5555-4555-8555-555555555555}";
    const deletedId = "{66666666-6666-4666-8666-666666666666}";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ values: [{ workspace: { uuid: workspaceId } }] }),
      )
      .mockResolvedValueOnce(
        response({
          values: [
            {
              permission: "write",
              repository: {
                type: "repository",
                name: "repo",
                full_name: "space/repo",
                uuid: repositoryId,
              },
            },
            {
              permission: "write",
              repository: {
                type: "repository",
                name: "empty",
                full_name: "space/empty",
                uuid: emptyId,
              },
            },
            {
              permission: "write",
              repository: {
                type: "repository",
                name: "gone",
                full_name: "space/gone",
                uuid: deletedId,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response(repository()))
      .mockResolvedValueOnce(
        response({ ...repository("empty"), uuid: emptyId, mainbranch: null }),
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(
      createBitbucketProvider(config, fetcher).listRepositories("token"),
    ).resolves.toMatchObject([{ fullName: "space/repo" }]);
  });

  it("aborts oversized streamed JSON and rejects pagination outside the endpoint", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
    });
    await expect(
      createBitbucketProvider(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
      ).getUser("token"),
    ).rejects.toMatchObject({ category: "invalid-response" });
    await expect(
      createBitbucketProvider(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(
          response({
            values: [],
            next: "https://api.bitbucket.org/2.0/repositories/attacker/private",
          }),
        ),
      ).listRepositories("token"),
    ).rejects.toMatchObject({ category: "invalid-response" });
  });
});
