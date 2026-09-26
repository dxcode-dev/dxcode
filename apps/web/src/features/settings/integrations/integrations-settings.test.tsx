// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
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
  githubConfigured = true,
) => {
  const queryClient = new QueryClient();
  if (data !== undefined)
    queryClient.setQueryData(integrationKeys.github(userId), {
      configured: githubConfigured,
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
  it("groups personal and organization installations under one GitHub integration", () => {
    const markup = render(
      ["octocat", "example-org"].map((login, index) => ({
        id: `grant-${index}`,
        status: "active",
        installationStatus: "active",
        account: {
          id: String(index),
          login,
          type: index === 0 ? "user" : "organization",
        },
      })),
      { configured: false, connection: null },
    );
    expect(markup.match(/aria-label="GitHub integration"/g)).toHaveLength(1);
    expect(markup).toContain("2 connected installations.");
    expect(markup).toContain("@octocat");
    expect(markup).toContain("@example-org");
    expect(markup).toContain("Personal");
    expect(markup).toContain("Organization");
    expect(markup.match(/>Configure</g)).toHaveLength(2);
    expect(markup.match(/>Disconnect</g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Configure @octocat"');
    expect(markup).toContain('aria-label="Configure @example-org"');
    expect(markup).toContain('aria-label="Disconnect @octocat"');
    expect(markup).toContain('aria-label="Disconnect @example-org"');
    expect(markup).toContain(">Connect another<");
  });

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

  it("registers integrations only for personal settings", () => {
    expect(settingsPath({ scope: "personal", section: "integrations" })).toBe(
      "/settings/integrations",
    );
    expect(
      resolveSettingsSection(settingsManifest, "personal", "integrations"),
    ).toMatchObject({ found: true });
    expect(
      resolveSettingsSection(settingsManifest, "workspace", "integrations"),
    ).toMatchObject({ found: false });
  });

  it("shows one GitHub row without a username while disconnected", () => {
    const markup = render([]);
    expect(markup).toContain("GitHub integration");
    expect(markup).toContain(">Connect<");
    expect(markup).not.toContain("on GitHub");
    expect(markup).not.toMatch(/workspace integration/i);
  });

  it("shows Configure and Disconnect for the connected account", () => {
    const markup = render([
      {
        id: "grant-1",
        ownerScope: "personal",
        ownerId: "user-1",
        installationId: "7",
        status: "active",
        installationStatus: "active",
        account: { id: "9", login: "octocat", type: "user" },
        repositorySelection: "selected",
        repositories: [
          {
            id: "101",
            fullName: "octocat/dx",
            webUrl: "https://github.com/octocat/dx",
            visibility: "private",
          },
        ],
      },
    ]);
    expect(markup).toContain("@octocat");
    expect(markup).toContain(">Configure<");
    expect(markup).toContain(">Disconnect<");
    expect(markup).not.toMatch(/selected repositor/i);
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

  it("shows Bitbucket as unavailable when the deployment is unconfigured", () => {
    const markup = render([], { configured: false, connection: null });
    expect(markup).toContain("Bitbucket integration");
    expect(markup).toContain("not configured");
  });

  it("shows GitHub as unavailable when the deployment is unconfigured", () => {
    const markup = render(
      [],
      { configured: false, connection: null },
      undefined,
      false,
    );
    expect(markup).toContain("GitHub integration");
    expect(markup).toContain(
      "GitHub is unavailable because it is not configured",
    );
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

  it("offers disconnect for a stored Bitbucket connection when disabled", () => {
    const markup = render([], {
      configured: false,
      connection: {
        id: "connection-1",
        accountName: "dx-team",
        status: "reauthorization-required",
      },
    });
    expect(markup).toContain("not configured");
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

  it("shows refresh and disconnect for a connected Bitbucket account", () => {
    const markup = render([], {
      configured: true,
      connection: {
        id: "connection-1",
        accountName: "dx-team",
        status: "active",
      },
    });
    expect(markup).toContain("dx-team on Bitbucket");
    expect(markup).toContain("Refresh status");
    expect(markup).toContain(">Disconnect<");
  });
});
