import type { FirstPartyPluginData } from "@dx/api";
import { describe, expect, it } from "vitest";
import { listedPlugins, pluginHint, pluginSwitch } from "./plugins-status.js";

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

describe("first-party Plugins settings", () => {
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
});
