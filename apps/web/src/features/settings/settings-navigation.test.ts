import { describe, expect, it } from "vitest";
import { settingsManifest } from "./foundation-sections.js";
import { settingsNavigationRegistrations } from "./settings-navigation.js";
import { resolveSettingsSection } from "./settings-registration.js";

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

  it("keeps Usage but does not register Billing or Budgets", () => {
    expect(
      resolveSettingsSection(settingsManifest, "personal", "billing"),
    ).toMatchObject({ found: false });
    expect(settingsManifest.personal.map(({ id }) => id)).toContain(
      "personal-usage",
    );
    expect(settingsManifest.workspace.map(({ id }) => id)).toContain(
      "workspace-usage",
    );
    expect(
      [...settingsManifest.personal, ...settingsManifest.workspace].some(
        ({ id, slug }) => id.includes("budget") || slug === "billing",
      ),
    ).toBe(false);
    expect(
      resolveSettingsSection(settingsManifest, "workspace", "applications"),
    ).toMatchObject({
      found: true,
      registration: { id: "workspace-applications" },
    });
  });
});
