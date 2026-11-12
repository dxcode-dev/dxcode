import type { FirstPartyPluginData } from "@dx/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import {
  pluginBundlesQueryOptions,
  pluginBundleUpdatesKey,
} from "./plugin-bundle-queries.js";
import { firstPartyPluginsQueryOptions } from "./plugins-queries.js";
import { PluginsSettings } from "./plugins-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_test" as never;
const target = { scope: "personal" } as const;
const search = {
  id: "search",
  displayName: "Web search",
  description: "Web search.",
  capabilities: ["web.search", "web.read"],
  alwaysOn: false,
  providers: [
    {
      id: "exa",
      displayName: "Exa",
      capabilities: ["web.search", "web.read"],
      credentialLabel: "Exa API key",
    },
  ],
  enablement: null,
  configuration: null,
  inherited: { workspace: null, deployment: { providerId: null } },
  effective: { status: "no-provider" },
  personalOverridesAllowed: true,
} satisfies FirstPartyPluginData;
const speech = {
  ...search,
  id: "speech",
  displayName: "Dictation",
  effective: {
    status: "active",
    provider: { providerId: "exa", scope: "deployment" },
    capabilities: ["web.search"],
  },
} satisfies FirstPartyPluginData;

/** The page as the app shows it: inside a router, at `url`. */
const routerAt = (url: string) =>
  createRouter({
    routeTree: createRootRoute({
      component: () => <PluginsSettings onDirtyChange={() => undefined} />,
    }),
    history: createMemoryHistory({ initialEntries: [url] }),
  });

const render = async (url: string, queryClient: QueryClient) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = routerAt(url);
  await act(async () => {
    root.render(
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
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
    await router.load();
  });
  return {
    container,
    unmount: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
};

const code = {
  apiVersion: 1,
  host: "worker",
  entry: "dev.dxcode/index.js",
  modules: [
    { path: "dev.dxcode/index.js", bytes: 10, integrity: "a".repeat(64) },
  ],
  permissions: {
    events: ["tool.call"],
    network: ["api.example.com"],
    secrets: [],
    tools: [],
    ai: false,
  },
  settings: [],
} as const;

const manifest = {
  format: "agent-plugins",
  name: "com.acme.notes",
  displayName: "Notes",
  description: "Takes notes.",
  version: "1.1.0",
  skills: [],
  mcpServers: [],
  code,
  skipped: [],
} as const;

const installed = {
  id: "plg_00000000-0000-4000-8000-000000000001",
  scope: "personal",
  name: "com.acme.notes",
  displayName: "Notes",
  description: "Takes notes.",
  version: "1.0.0",
  enabled: true,
  source: {
    type: "github",
    repository: "acme/kit",
    ref: "main",
    path: "plugins/notes",
    commit: "7".repeat(40),
  },
  integrity: "b".repeat(64),
  skills: [],
  mcpServers: [],
  code,
  skipped: [],
  installedAt: "2026-11-10T12:00:00.000Z",
  updatedAt: "2026-11-10T12:00:00.000Z",
} as const;

const seeded = (data: Record<string, unknown>) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    firstPartyPluginsQueryOptions(userId, target).queryKey,
    { scope: "personal", canUpdate: true, plugins: [] },
  );
  queryClient.setQueryData(pluginBundlesQueryOptions(userId, target).queryKey, {
    items: [],
    canMutate: true,
    ...data,
  } as never);
  return queryClient;
};

const buttons = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === name,
  );

describe("Plugins settings", () => {
  it("opens a share link on the plugin's review, with its signer and what its code may reach", async () => {
    const queryClient = seeded({});
    queryClient.setQueryData(["plugin-share-preview", target, "t".repeat(43)], {
      manifest,
      source: {
        type: "share",
        linkId: "psl_00000000-0000-4000-8000-000000000001",
        label: "Shared by Ana",
      },
      integrity: "c".repeat(64),
      conflicts: [],
      signature: {
        fingerprint: "SHA256:9wmXe/075eN/BLBm95MuE0dI3/usDPjqnvGd1PfESjI",
        publicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN5S1Nx4sgD6QSU32YV2xVhjo30Q6BMPebhp7hLNB8mR",
        signer: { kind: "publisher", domain: "acme.com" },
      },
    });
    const page = await render(
      `/settings/plugins?share=${"t".repeat(43)}`,
      queryClient,
    );
    try {
      const dialog = document.querySelector(".plugin-bundle-dialog");
      expect(dialog?.textContent).toContain("Review Notes");
      expect(dialog?.textContent).toContain("Shared by Ana");
      expect(dialog?.textContent).toContain("Signed by acme.com");
      expect(dialog?.textContent).toContain("api.example.com");
      expect(buttons(document, "Install")).toHaveLength(1);
    } finally {
      await page.unmount();
    }
  });

  it("lists dx's proposal and opens its review link on the wider permissions", async () => {
    const proposal = {
      id: "apr_00000000-0000-4000-8000-000000000001",
      change: "update",
      name: "com.acme.notes",
      pluginId: installed.id,
      source: { ...installed.source, commit: "8".repeat(40) },
      integrity: "d".repeat(64),
      manifest,
      permissions: {
        widens: true,
        changes: [
          { permission: "network", added: ["api.other.com"], removed: [] },
        ],
      },
      skills: [],
      mcpServers: [],
      note: "1.1.0 adds a second API.",
      threadId: "thr_00000000-0000-4000-8000-000000000001",
      threadTitle: "Notes work",
      createdAt: "2026-11-10T12:00:00.000Z",
    };
    const page = await render(
      `/settings/plugins?proposal=${proposal.id}`,
      seeded({ items: [installed], proposals: [proposal] }),
    );
    try {
      expect(
        page.container.querySelector('[aria-label="Proposed by dx"]')
          ?.textContent,
      ).toContain("Update to 1.1.0");
      const dialog = document.querySelector(".plugin-bundle-dialog");
      expect(dialog?.textContent).toContain("Update Notes?");
      expect(dialog?.textContent).toContain("api.other.com");
      expect(dialog?.textContent).toContain(
        "This version asks for more than you approved.",
      );
      expect(buttons(document, "Approve and update")).toHaveLength(1);
    } finally {
      await page.unmount();
    }
  });

  it("offers Update on a plugin whose source has a newer version", async () => {
    const queryClient = seeded({ items: [installed] });
    queryClient.setQueryData(pluginBundleUpdatesKey(userId, target), {
      items: [{ pluginId: installed.id, available: true }],
    });
    const page = await render("/settings/plugins", queryClient);
    try {
      const row = page.container.querySelector(
        '[data-plugin-bundle="com.acme.notes"]',
      );
      expect(
        row?.querySelector('button[aria-label="Update Notes"]'),
      ).not.toBeNull();
    } finally {
      await page.unmount();
    }
  });

  it("offers Set up instead of an on switch for a plugin that needs a key", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      firstPartyPluginsQueryOptions(userId, target).queryKey,
      { scope: "personal", canUpdate: true, plugins: [search, speech] },
    );
    queryClient.setQueryData(
      pluginBundlesQueryOptions(userId, target).queryKey,
      { items: [], canMutate: false },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
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
              <RouterProvider router={routerAt("/settings/plugins")} />
            </QueryClientProvider>
          </AuthContext.Provider>,
        ),
      );
      const row = (name: string) =>
        [...container.querySelectorAll(".first-party-plugin-row")].find(
          (element) => element.querySelector("strong")?.textContent === name,
        );
      const searchRow = row("Web search");
      expect(searchRow?.textContent).toContain("Needs an API key");
      // No switch claims the plugin is on while it cannot work.
      expect(searchRow?.querySelector(".settings-toggle")).toBeNull();
      const setUp = [...(searchRow?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Set up",
      );
      expect(setUp).toBeDefined();
      // A working plugin keeps its switch.
      expect(
        row("Dictation")?.querySelector(".settings-toggle"),
      ).not.toBeNull();
      await act(async () => setUp?.click());
      expect(
        document.querySelector('input[aria-label="Exa API key"]'),
      ).not.toBeNull();
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  });
});
