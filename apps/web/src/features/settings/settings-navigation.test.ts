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
      "Integrations",
      "Advanced",
      "Appearance",
      "Keyboard Shortcuts",
    ]);

    expect(
      settingsNavigationRegistrations(
        "workspace",
        settingsManifest.workspace,
      ).map(({ label }) => label),
    ).toEqual(["Workspace", "Secrets & Env Vars"]);
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
