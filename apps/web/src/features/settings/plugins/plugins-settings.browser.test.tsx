import type { FirstPartyPluginData } from "@dx/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { pluginBundlesQueryOptions } from "./plugin-bundle-queries.js";
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

describe("Plugins settings", () => {
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
              <PluginsSettings onDirtyChange={() => undefined} />
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
