import type { FirstPartyPluginData } from "@dx/api";
import { describe, expect, it } from "vitest";
import { settingsManifest } from "../foundation-sections.js";
import { resolveSettingsSection } from "../settings-registration.js";
import {
  credentialPlaceholder,
  listedPlugins,
  pluginHint,
  pluginSwitch,
} from "./plugins-status.js";

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
  inherited: { workspace: null, deployment: { providerId: "exa" } },
  effective: { status: "no-provider" },
  personalOverridesAllowed: true,
} satisfies FirstPartyPluginData;

const speech = {
  ...search,
  id: "speech",
  displayName: "Dictation",
  capabilities: ["speech.transcribe"],
  providers: [
    {
      id: "sarvam",
      displayName: "Sarvam",
      capabilities: ["speech.transcribe"],
      credentialLabel: "Sarvam API key",
    },
  ],
  inherited: { workspace: null, deployment: { providerId: "sarvam" } },
  effective: {
    status: "active",
    provider: { providerId: "sarvam", scope: "deployment" },
    capabilities: ["speech.transcribe"],
  },
} satisfies FirstPartyPluginData;

describe("first-party Plugins settings", () => {
  it("lists Speech from registry data with the same row rules as Search", () => {
    expect(listedPlugins([search, speech]).map(({ id }) => id)).toEqual([
      "search",
      "speech",
    ]);
    expect(pluginHint(speech, "personal")).toBeUndefined();
    expect(credentialPlaceholder(speech, "sarvam", "personal")).toBe(
      "Using the deployment key",
    );
    const locked = {
      ...speech,
      inherited: {
        workspace: { enablement: "disabled", providerId: null },
        deployment: { providerId: "sarvam" },
      },
      effective: { status: "disabled", by: "workspace" },
    } satisfies FirstPartyPluginData;
    expect(pluginSwitch(locked, "personal")).toEqual({
      checked: false,
      locked: true,
    });
    expect(pluginHint(locked, "personal")).toBe("Disabled by your workspace");
  });

  it("never lists always-on Code as a plugin", () => {
    const code = {
      ...search,
      id: "code",
      displayName: "Code",
      capabilities: ["code.execute"],
      alwaysOn: true,
      providers: [
        {
          id: "quickjs",
          displayName: "QuickJS",
          capabilities: ["code.execute"],
          credentialLabel: null,
        },
      ],
    } satisfies FirstPartyPluginData;
    expect(listedPlugins([search, code]).map(({ id }) => id)).toEqual([
      "search",
    ]);
  });

  it("owns the plugins slug in both scopes and moves imported bundles to custom-plugins", () => {
    for (const scope of ["personal", "workspace"] as const) {
      expect(
        resolveSettingsSection(settingsManifest, scope, "plugins"),
      ).toMatchObject({
        found: true,
        registration: { id: `${scope}-plugins`, label: "Plugins" },
      });
      expect(
        resolveSettingsSection(settingsManifest, scope, "custom-plugins"),
      ).toMatchObject({
        found: true,
        registration: {
          id: `${scope}-custom-plugins`,
          label: "Custom plugins",
        },
      });
    }
  });

  it("shows one switch and a hint only when the plugin cannot work", () => {
    const active = {
      ...search,
      effective: {
        status: "active",
        provider: { providerId: "exa", scope: "deployment" },
        capabilities: ["web.search", "web.read"],
      },
    } satisfies FirstPartyPluginData;
    expect(pluginSwitch(active, "personal")).toEqual({
      checked: true,
      locked: false,
    });
    expect(pluginHint(active, "personal")).toBeUndefined();
    expect(pluginHint(search, "personal")).toBe("Needs an API key");
    const workspaceOff = {
      ...search,
      inherited: {
        workspace: { enablement: "disabled", providerId: null },
        deployment: { providerId: "exa" },
      },
      effective: { status: "disabled", by: "workspace" },
    } satisfies FirstPartyPluginData;
    expect(pluginSwitch(workspaceOff, "personal")).toEqual({
      checked: false,
      locked: true,
    });
    expect(pluginHint(workspaceOff, "personal")).toBe(
      "Disabled by your workspace",
    );
    expect(
      pluginSwitch(
        { ...search, effective: { status: "disabled", by: "personal" } },
        "personal",
      ),
    ).toEqual({ checked: false, locked: false });
  });

  it("says where the key comes from inside the empty key field", () => {
    expect(credentialPlaceholder(search, "exa", "personal")).toBe(
      "Using the deployment key",
    );
    expect(
      credentialPlaceholder(
        {
          ...search,
          configuration: { providerId: "exa", configuredAt: "2026-10-03" },
        },
        "exa",
        "personal",
      ),
    ).toBe("Key saved. Enter a new key to replace it.");
    expect(
      credentialPlaceholder(
        {
          ...search,
          inherited: {
            workspace: { enablement: null, providerId: "exa" },
            deployment: { providerId: "exa" },
          },
        },
        "exa",
        "personal",
      ),
    ).toBe("Using the workspace key");
    expect(
      credentialPlaceholder(
        {
          ...search,
          inherited: { workspace: null, deployment: { providerId: null } },
        },
        "exa",
        "workspace",
      ),
    ).toBe("Paste an API key");
  });
});
