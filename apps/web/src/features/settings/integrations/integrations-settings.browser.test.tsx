import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { bitbucketKeys } from "./bitbucket-queries.js";
import { integrationKeys } from "./integration-queries.js";
import { IntegrationsSettings } from "./integrations-settings.js";

const ceremonies = vi.hoisted(() => ({
  authorize: vi.fn(async (_returnTo?: string): Promise<string> => {
    throw new Error("authorization started");
  }),
  install: vi.fn(async () => {
    throw new Error("installation started");
  }),
}));
const navigation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./integration-mutations.js", async (original) => ({
  ...(await original<typeof import("./integration-mutations.js")>()),
  beginPersonalGitHubAuthorization: ceremonies.authorize,
  beginPersonalGitHubInstallation: ceremonies.install,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigation,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "user-1" as never;
const render = (
  data?: unknown,
  bitbucket?: unknown,
  bitbucketError?: Error,
) => {
  const queryClient = new QueryClient();
  if (data !== undefined)
    queryClient.setQueryData(integrationKeys.github(userId), {
      configured: true,
      grants: data,
    });
  if (bitbucket !== undefined) {
    const queryKey = bitbucketKeys.connection(userId);
    queryClient.setQueryData(queryKey, bitbucket);
    if (bitbucketError !== undefined) {
      const query = queryClient.getQueryCache().find({ queryKey });
      query?.setState({
        ...query.state,
        error: bitbucketError,
        status: "error",
      });
    }
  }
  return renderToStaticMarkup(
    <AuthContext.Provider
      value={{
        identity: {
          id: userId,
          name: "Test User",
          email: "test@example.com",
        },
        logout: () => undefined,
      }}
    >
      <QueryClientProvider client={queryClient}>
        <IntegrationsSettings onDirtyChange={() => undefined} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
};

describe("integrations settings", () => {
  it.each(["reauthorization-required", "active"])(
    "reconnect chooses the right ceremony for %s",
    async (status) => {
      ceremonies.authorize.mockClear();
      ceremonies.install.mockClear();
      const client = new QueryClient();
      client.setQueryData(bitbucketKeys.connection(userId), {
        configured: false,
        connection: null,
      });
      client.setQueryData(integrationKeys.github(userId), {
        configured: true,
        grants: [
          {
            id: "grant-1",
            status,
            installationStatus: "suspended",
            account: { id: "9", login: "octocat", type: "user" },
          },
        ],
      });
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <AuthContext.Provider
              value={{
                identity: {
                  id: userId,
                  name: "Test",
                  email: "test@example.com",
                },
                logout: () => undefined,
              }}
            >
              <QueryClientProvider client={client}>
                <IntegrationsSettings onDirtyChange={() => undefined} />
              </QueryClientProvider>
            </AuthContext.Provider>,
          ),
        );
        const button = [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Reconnect",
        );
        expect(button).toBeDefined();
        await act(async () => button?.click());
        expect(ceremonies.authorize).toHaveBeenCalledTimes(
          status === "reauthorization-required" ? 1 : 0,
        );
        expect(ceremonies.install).toHaveBeenCalledTimes(
          status === "active" ? 1 : 0,
        );
      } finally {
        await act(async () => root.unmount());
        client.clear();
      }
    },
  );

  it("replaces the document and sends the DX return target for GitHub OAuth", async () => {
    navigation.mockClear();
    const client = new QueryClient();
    client.setQueryData(integrationKeys.github(userId), {
      configured: true,
      grants: [],
    });
    client.setQueryData(bitbucketKeys.connection(userId), {
      configured: false,
      connection: null,
    });
    ceremonies.authorize.mockResolvedValueOnce(
      "https://github.com/login/oauth/authorize",
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    try {
      await act(async () =>
        root.render(
          <AuthContext.Provider
            value={{
              identity: {
                id: userId,
                name: "Test",
                email: "test@example.com",
              },
              logout: () => undefined,
            }}
          >
            <QueryClientProvider client={client}>
              <IntegrationsSettings
                onDirtyChange={() => undefined}
                settingsReturnTo="/projects"
              />
            </QueryClientProvider>
          </AuthContext.Provider>,
        ),
      );
      const connect = container.querySelector<HTMLButtonElement>(
        '[aria-label="GitHub integration"] button',
      );
      expect(connect).not.toBeNull();

      await act(async () => connect?.click());

      expect(navigation).toHaveBeenCalledWith({
        href: "https://github.com/login/oauth/authorize",
        replace: true,
        reloadDocument: true,
      });
      expect(ceremonies.authorize).toHaveBeenCalledWith("/projects");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
    }
  });

  it("requires reconnection before a revoked GitHub installation can disconnect", () => {
    const markup = render([
      {
        id: "grant-1",
        status: "reauthorization-required",
        installationStatus: "active",
        account: { id: "9", login: "octocat", type: "user" },
      },
    ]);
    expect(markup).toContain('aria-label="Reconnect @octocat"');
    expect(markup).not.toContain(">Disconnect<");
  });

  it("offers reconnect for revoked or expired Bitbucket authorization", () => {
    const markup = render([], {
      configured: true,
      connection: {
        id: "connection-1",
        accountName: "dx-team",
        status: "reauthorization-required",
      },
    });
    expect(markup).toContain("expired or was revoked");
    expect(markup).toContain(">Reconnect<");
    expect(markup).toContain(">Disconnect<");
  });

  it("does not treat an active stored connection as active when disabled", () => {
    const markup = render([], {
      configured: false,
      connection: {
        id: "connection-1",
        accountName: "dx-team",
        status: "active",
      },
    });
    expect(markup).toContain("not configured");
    expect(markup).toContain(">Disconnect<");
    expect(markup).not.toContain("Refresh status");
    expect(markup).not.toContain("dx-team on Bitbucket");
  });

  it("offers retry and disconnect when refresh fails with cached connection", () => {
    const markup = render(
      [],
      {
        configured: true,
        connection: {
          id: "connection-1",
          accountName: "dx-team",
          status: "active",
        },
      },
      new Error("status refresh failed"),
    );
    expect(markup).toContain("Connection status is unavailable");
    expect(markup).toContain(">Retry<");
    expect(markup).toContain(">Disconnect<");
  });

  it("explains who can turn on Bitbucket when this deployment lacks it", () => {
    const markup = render([], { configured: false, connection: null });
    expect(markup).toContain("not configured on this deployment");
    expect(markup).toContain("whoever runs this dx deployment");
    expect(markup).not.toContain(">Connect<");
  });

  it.each([
    [
      "connects",
      {
        status: 200,
        body: {
          status: "success",
          data: {
            configured: true,
            connection: { id: "bb-1", accountName: "team", status: "active" },
          },
        },
      },
      "team on Bitbucket",
    ],
    [
      "fails",
      { status: 503, body: { error: "unavailable" } },
      "Connection status is unavailable",
    ],
  ] as const)(
    "keeps every card in place while Bitbucket is slow, then %s",
    async (_outcome, bitbucketAnswer, bitbucketText) => {
      const answers = new Map<string, (response: Response) => void>();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (input: RequestInfo | URL) =>
            new Promise<Response>((resolve) => {
              const path = new URL(String(input), window.location.href)
                .pathname;
              answers.set(path, resolve);
            }),
        ),
      );
      const answer = async (path: string, status: number, body: unknown) => {
        await vi.waitFor(() => expect(answers.has(path)).toBe(true));
        await act(async () => {
          answers.get(path)?.(Response.json(body, { status }));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      // Each shown card as "section / group: card", in page order.
      const placements: string[][] = [];
      const record = () =>
        placements.push(
          [...container.querySelectorAll<HTMLElement>(".integration-tile")].map(
            (card) => {
              const section = card
                .closest(".integrations-section")
                ?.querySelector("h2")?.textContent;
              const group =
                card.closest(".integration-group")?.querySelector("h3")
                  ?.textContent ?? "";
              return `${section} / ${group}: ${card.getAttribute("aria-label")}`;
            },
          ),
        );
      const section = (title: string) =>
        [...container.querySelectorAll(".integrations-section")].find(
          (element) => element.querySelector("h2")?.textContent === title,
        );
      try {
        await act(async () =>
          root.render(
            <AuthContext.Provider
              value={{
                identity: {
                  id: userId,
                  name: "Test",
                  email: "test@example.com",
                },
                logout: () => undefined,
              }}
            >
              <QueryClientProvider
                client={
                  new QueryClient({
                    defaultOptions: { queries: { retry: false } },
                  })
                }
              >
                <IntegrationsSettings onDirtyChange={() => undefined} />
              </QueryClientProvider>
            </AuthContext.Provider>,
          ),
        );
        record();
        // Source control shows at once, in a fixed order, before any read.
        expect(placements[0]).toEqual([
          "Integrations / : GitHub integration",
          "Integrations / : Bitbucket integration",
        ]);
        await answer("/v1/settings/personal/mcp-servers", 200, {
          status: "success",
          data: { items: [], canMutate: true },
        });
        record();
        await answer("/v1/integrations/github/personal/grants", 200, {
          status: "success",
          data: {
            configured: true,
            grants: [
              {
                id: "grant-1",
                ownerScope: "personal",
                ownerId: "user-1",
                installationId: "1",
                status: "active",
                installationStatus: "active",
                account: { id: "9", login: "octocat", type: "user" },
                repositorySelection: "all",
                repositories: [],
              },
            ],
          },
        });
        record();
        // Bitbucket is still checking, yet MCP is placed and usable.
        expect(section("Integrations")?.textContent).toContain(
          "Checking connection",
        );
        const mcp = section("MCP");
        expect(
          [...(mcp?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent?.trim() === "Add MCP Server",
          ),
        ).toBeDefined();
        expect(mcp?.textContent).toContain("Notion");
        await answer(
          "/v1/integrations/bitbucket/personal/connection",
          bitbucketAnswer.status,
          bitbucketAnswer.body,
        );
        record();
        expect(section("Integrations")?.textContent).toContain(bitbucketText);

        const final = placements.at(-1) ?? [];
        expect(final.slice(0, 2)).toEqual([
          "Integrations / : GitHub integration",
          "Integrations / : Bitbucket integration",
        ]);
        // A card never changes place: every earlier frame is the final
        // page without the MCP cards that had not loaded yet.
        for (const placement of placements)
          expect(placement).toEqual(
            final.filter((card) => placement.includes(card)),
          );
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
