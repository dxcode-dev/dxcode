import { describe, expect, it } from "vitest";
import { settingsManifest } from "./foundation-sections.js";
import { settingsNavigationRegistrations } from "./settings-navigation.js";

describe("settings navigation", () => {
  it("shows only the settings features currently exposed in each menu", () => {
    expect(
      settingsNavigationRegistrations(
        "personal",
        settingsManifest.personal,
      ).map(({ label }) => label),
    ).toEqual([
      "Account",
      "Secrets & Env Vars",
      "Model Routing",
      "Mode Dial",
      "MCP & Integrations",
      "Plugins",
      "Orb Providers",
      "Advanced",
      "Appearance",
      "Keyboard Shortcuts",
    ]);

    expect(
      settingsNavigationRegistrations(
        "workspace",
        settingsManifest.workspace,
        "admin",
      ).map(({ label }) => label),
    ).toEqual([
      "Workspace",
      "Members",
      "Secrets & Env Vars",
      "Model Routing",
      "Mode Dial",
      "MCP & Integrations",
      "Plugins",
      "Orb Providers",
    ]);

    // Members see shared configuration read-only; admin-only sections hide.
    expect(
      settingsNavigationRegistrations(
        "workspace",
        settingsManifest.workspace,
        "member",
      ).map(({ label }) => label),
    ).toEqual(["Workspace", "Members", "MCP & Integrations", "Plugins"]);
  });
});
