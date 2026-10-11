import { describe, expect, it } from "vitest";
import type { Bindings } from "../http/types.js";
import {
  deploymentProvider,
  FIRST_PARTY_PLUGINS,
  installedPlugins,
} from "./registry.js";
import {
  type PluginResolutionInput,
  pluginToolSet,
  resolvePlugin,
} from "./resolution.js";

const [search] = FIRST_PARTY_PLUGINS;
if (search === undefined) throw new Error("Search must be registered.");
const [exa] = search.providers;
if (exa === undefined) throw new Error("Exa must be registered.");
const unset = { enablement: null, providerId: null } as const;
const input = (
  overrides: Partial<PluginResolutionInput> = {},
): PluginResolutionInput => ({
  plugin: search,
  deploymentProviderId: "exa",
  workspace: unset,
  personal: unset,
  personalOverridesAllowed: true,
  ...overrides,
});
const active = (scope: "personal" | "workspace" | "deployment") => ({
  status: "active",
  provider: { providerId: "exa", scope },
  capabilities: ["web.search", "web.read"],
});

describe("first-party plugin resolution", () => {
  it("prefers personal over workspace over deployment configuration", () => {
    const workspace = { enablement: null, providerId: "exa" } as const;
    expect(resolvePlugin(input({ workspace }))).toEqual(active("workspace"));
    expect(
      resolvePlugin(
        input({ workspace, personal: { enablement: null, providerId: "exa" } }),
      ),
    ).toEqual(active("personal"));
    expect(
      resolvePlugin(
        input({
          deploymentProviderId: undefined,
          workspace: undefined,
          personal: { enablement: null, providerId: "exa" },
        }),
      ),
    ).toEqual(active("personal"));
  });

  it("lets a personal disabled turn the plugin off for that person", () => {
    expect(
      resolvePlugin(
        input({
          workspace: { enablement: "enabled", providerId: "exa" },
          personal: { enablement: "disabled", providerId: null },
        }),
      ),
    ).toEqual({ status: "disabled", by: "personal" });
  });

  it("ignores personal configuration when workspace policy denies overrides, without disabling", () => {
    const personal = { enablement: null, providerId: "exa" } as const;
    expect(
      resolvePlugin(input({ personal, personalOverridesAllowed: false })),
    ).toEqual(active("deployment"));
    expect(
      resolvePlugin(
        input({
          personal,
          workspace: { enablement: null, providerId: "exa" },
          personalOverridesAllowed: false,
        }),
      ),
    ).toEqual(active("workspace"));
    // Denial never falls through to a personal key when nothing else exists.
    expect(
      resolvePlugin(
        input({
          personal,
          deploymentProviderId: undefined,
          personalOverridesAllowed: false,
        }),
      ),
    ).toEqual({ status: "no-provider" });
  });

  it("exposes only the capabilities the provider claims", () => {
    const readOnly = {
      ...search,
      providers: [{ ...exa, capabilities: ["web.read"] }],
    } as typeof search;
    expect(resolvePlugin(input({ plugin: readOnly }))).toEqual({
      status: "active",
      provider: { providerId: "exa", scope: "deployment" },
      capabilities: ["web.read"],
    });
  });
});

describe("deployment-scope plugin configuration", () => {
  const deployed = (bindings: Partial<Bindings>): Bindings => ({
    DX_RUNTIME_MODE: "deployed",
    ...bindings,
  });

  it("resolves always-on Code to QuickJS in every mode, ignoring enablement", () => {
    const code = FIRST_PARTY_PLUGINS.find(({ id }) => id === "code");
    if (!code) throw new Error("Code must be registered");
    for (const mode of ["local", "deployed"] as const) {
      expect(deploymentProvider(code, { DX_RUNTIME_MODE: mode })).toBe(
        "quickjs",
      );
      expect(
        resolvePlugin(input({ plugin: code, deploymentProviderId: "quickjs" })),
      ).toEqual({
        status: "active",
        provider: { providerId: "quickjs", scope: "deployment" },
        capabilities: ["code.execute"],
      });
    }
    expect(
      resolvePlugin(
        input({
          plugin: code,
          deploymentProviderId: "quickjs",
          workspace: { enablement: "disabled", providerId: null },
        }),
      ),
    ).toEqual({
      status: "active",
      provider: { providerId: "quickjs", scope: "deployment" },
      capabilities: ["code.execute"],
    });
    expect(
      resolvePlugin(
        input({
          plugin: code,
          deploymentProviderId: "quickjs",
          personal: { enablement: "disabled", providerId: null },
        }),
      ).status,
    ).toBe("active");
  });

  it("installs listed first-party plugins plus the always-on ones", () => {
    const ids = (value?: string) =>
      installedPlugins(
        deployed(value === undefined ? {} : { DX_INSTALLED_PLUGINS: value }),
      ).map(({ id }) => id);
    expect(ids()).toEqual(["code", "execution"]);
    expect(ids("unknown")).toEqual(["code", "execution"]);
    expect(ids(" search ,other")).toEqual(["search", "code", "execution"]);
  });

  it("derives the deployment provider from its secret binding only when deployed", () => {
    expect(deploymentProvider(search, deployed({}))).toBeUndefined();
    expect(
      deploymentProvider(search, deployed({ EXA_API_KEY: "  " })),
    ).toBeUndefined();
    expect(deploymentProvider(search, deployed({ EXA_API_KEY: "key" }))).toBe(
      "exa",
    );
    // Local runtime never spends credits, even with a real key present.
    expect(
      deploymentProvider(search, {
        DX_RUNTIME_MODE: "local",
        EXA_API_KEY: "key",
      }),
    ).toBe("fixture");
    expect(deploymentProvider(search, {})).toBe("fixture");
  });
});

describe("Execution plugin resolution", () => {
  const execution = FIRST_PARTY_PLUGINS.find(({ id }) => id === "execution");
  if (execution === undefined) throw new Error("Execution must be registered.");

  it("is a required slot: always installed, never disabled", () => {
    expect(installedPlugins({ DX_INSTALLED_PLUGINS: "" })).toContain(execution);
    expect(
      resolvePlugin({
        plugin: execution,
        deploymentProviderId: "e2b",
        workspace: { enablement: "disabled", providerId: null },
        personal: { enablement: "disabled", providerId: null },
        personalOverridesAllowed: true,
      }),
    ).toMatchObject({
      status: "active",
      provider: { providerId: "e2b", scope: "deployment" },
    });
    expect(
      resolvePlugin({
        plugin: execution,
        deploymentProviderId: undefined,
        workspace: undefined,
        personal: unset,
        personalOverridesAllowed: true,
      }),
    ).toEqual({ status: "no-provider" });
  });

  it("is never part of a submission's tool set", () => {
    const state = (
      plugin: (typeof FIRST_PARTY_PLUGINS)[number],
      deploymentProviderId: "e2b" | "quickjs",
    ) => ({
      plugin,
      deploymentProviderId,
      workspaceSetting: undefined,
      personalSetting: undefined,
      personalOverridesAllowed: true,
      resolution: resolvePlugin({
        plugin,
        deploymentProviderId,
        workspace: undefined,
        personal: unset,
        personalOverridesAllowed: true,
      }),
    });
    const code = FIRST_PARTY_PLUGINS.find(({ id }) => id === "code");
    if (code === undefined) throw new Error("Code must be registered.");
    expect(
      pluginToolSet({
        userId: "user",
        workspaceId: undefined,
        plugins: [state(code, "quickjs"), state(execution, "e2b")],
      }),
    ).toEqual([{ pluginId: "code", capabilities: ["code.execute"] }]);
  });
});
