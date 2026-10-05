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
  it("uses the deployment configuration when nothing else is set", () => {
    expect(resolvePlugin(input())).toEqual(active("deployment"));
    expect(resolvePlugin(input({ workspace: undefined }))).toEqual(
      active("deployment"),
    );
  });

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

  it("keeps a workspace disabled absolute even when personal says enabled", () => {
    expect(
      resolvePlugin(
        input({
          workspace: { enablement: "disabled", providerId: null },
          personal: { enablement: "enabled", providerId: "exa" },
        }),
      ),
    ).toEqual({ status: "disabled", by: "workspace" });
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

  it("contributes nothing when no provider resolves, even when enabled everywhere", () => {
    expect(
      resolvePlugin(
        input({
          deploymentProviderId: undefined,
          workspace: { enablement: "enabled", providerId: null },
          personal: { enablement: "enabled", providerId: null },
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

describe("Speech plugin resolution", () => {
  const speech = FIRST_PARTY_PLUGINS.find(({ id }) => id === "speech");
  if (speech === undefined) throw new Error("Speech must be registered.");
  const sarvam = (scope: "personal" | "workspace" | "deployment") => ({
    status: "active",
    provider: { providerId: "sarvam", scope },
    capabilities: ["speech.transcribe"],
  });
  const personalKey = { enablement: null, providerId: "sarvam" } as const;
  const speechInput = (overrides: Partial<PluginResolutionInput> = {}) =>
    input({
      plugin: speech,
      deploymentProviderId: deploymentProvider(speech, {
        DX_RUNTIME_MODE: "deployed",
        SARVAM_API_KEY: "deployment-key",
      }),
      ...overrides,
    });

  it("registers Sarvam as the provider of speech.transcribe, metered in audio seconds", () => {
    expect(speech.capabilities).toEqual(["speech.transcribe"]);
    expect(speech.providers).toEqual([
      expect.objectContaining({
        id: "sarvam",
        capabilities: ["speech.transcribe"],
        deploymentSecret: "SARVAM_API_KEY",
        unit: "audio_second",
      }),
    ]);
  });

  it("uses the deployment SARVAM_API_KEY alone, and nothing without it", () => {
    expect(resolvePlugin(speechInput())).toEqual(sarvam("deployment"));
    expect(
      deploymentProvider(speech, { DX_RUNTIME_MODE: "deployed" }),
    ).toBeUndefined();
    expect(
      resolvePlugin(speechInput({ deploymentProviderId: undefined })),
    ).toEqual({ status: "no-provider" });
    // Local runtime resolves the fixture whether or not a key is present.
    expect(
      deploymentProvider(speech, {
        DX_RUNTIME_MODE: "local",
        SARVAM_API_KEY: "key",
      }),
    ).toBe("fixture");
  });

  it("prefers a personal Sarvam key, with or without a deployment key", () => {
    expect(resolvePlugin(speechInput({ personal: personalKey }))).toEqual(
      sarvam("personal"),
    );
    expect(
      resolvePlugin(
        speechInput({ personal: personalKey, deploymentProviderId: undefined }),
      ),
    ).toEqual(sarvam("personal"));
    expect(
      resolvePlugin(
        speechInput({
          workspace: { enablement: null, providerId: "sarvam" },
          deploymentProviderId: undefined,
        }),
      ),
    ).toEqual(sarvam("workspace"));
  });

  it("is off for members when the workspace disables it, even with a personal key", () => {
    expect(
      resolvePlugin(
        speechInput({
          workspace: { enablement: "disabled", providerId: null },
          personal: { enablement: "enabled", providerId: "sarvam" },
        }),
      ),
    ).toEqual({ status: "disabled", by: "workspace" });
  });

  it("ignores a personal key when policy denies overrides, without falling through to it", () => {
    expect(
      resolvePlugin(
        speechInput({ personal: personalKey, personalOverridesAllowed: false }),
      ),
    ).toEqual(sarvam("deployment"));
    expect(
      resolvePlugin(
        speechInput({
          personal: personalKey,
          personalOverridesAllowed: false,
          deploymentProviderId: undefined,
        }),
      ),
    ).toEqual({ status: "no-provider" });
  });

  it("is not installed unless DX_INSTALLED_PLUGINS lists it", () => {
    const ids = (value: string) =>
      installedPlugins({
        DX_RUNTIME_MODE: "deployed",
        DX_INSTALLED_PLUGINS: value,
        SARVAM_API_KEY: "deployment-key",
      }).map(({ id }) => id);
    expect(ids("search")).not.toContain("speech");
    expect(ids("search,speech")).toEqual([
      "search",
      "speech",
      "code",
      "execution",
    ]);
  });
});

describe("Execution plugin resolution", () => {
  const execution = FIRST_PARTY_PLUGINS.find(({ id }) => id === "execution");
  if (execution === undefined) throw new Error("Execution must be registered.");

  it("resolves E2B only from the deployment E2B key, and the local runtime in development", () => {
    expect(
      deploymentProvider(execution, { DX_RUNTIME_MODE: "deployed" }),
    ).toBeUndefined();
    expect(
      deploymentProvider(execution, {
        DX_RUNTIME_MODE: "deployed",
        E2B_API_KEY: " ",
      }),
    ).toBeUndefined();
    expect(
      deploymentProvider(execution, {
        DX_RUNTIME_MODE: "deployed",
        E2B_API_KEY: "key",
      }),
    ).toBe("e2b");
    // Development never reaches E2B, even with a key present.
    expect(
      deploymentProvider(execution, {
        DX_RUNTIME_MODE: "local",
        E2B_API_KEY: "key",
      }),
    ).toBe("local");
  });

  it("is a required slot: always installed, never disabled; only E2B takes a person's key", () => {
    expect(installedPlugins({ DX_INSTALLED_PLUGINS: "" })).toContain(execution);
    // Bring-your-own keys (4b) apply to key-based providers only; the
    // Orb Providers routes own them, not this per-user resolution.
    expect(
      execution.providers.map(({ id, credentialLabel }) => [
        id,
        credentialLabel,
      ]),
    ).toEqual([
      ["e2b", "E2B API key"],
      ["cloudflare", null],
      ["local", null],
    ]);
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

  it("claims only what each provider implements", () => {
    const resolve = (providerId: "e2b" | "local") =>
      resolvePlugin({
        plugin: execution,
        deploymentProviderId: providerId,
        workspace: undefined,
        personal: unset,
        personalOverridesAllowed: true,
      });
    expect(resolve("e2b")).toMatchObject({
      capabilities: [
        "execution.workspace",
        "execution.resident-daemon",
        "execution.pause-resume",
      ],
    });
    expect(resolve("local")).toMatchObject({
      capabilities: ["execution.workspace", "execution.resident-daemon"],
    });
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
