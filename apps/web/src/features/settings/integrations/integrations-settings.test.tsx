// @vitest-environment happy-dom

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
vi.mock("@tanstack/react-router", () => ({
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
});
