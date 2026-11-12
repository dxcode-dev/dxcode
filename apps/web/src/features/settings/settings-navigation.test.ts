import type { SettingsScope, WorkspaceRole } from "@dx/domain";
import { describe, expect, it } from "vitest";
import { registeredDeploymentSettingsSections } from "./deployment-settings-registration.js";
import { settingsManifest } from "./foundation-sections.js";
import { settingsNavigationSections } from "./settings-navigation.js";

// What a deployment registers on top (none in the public export).
const deploymentSections = new Set(
  registeredDeploymentSettingsSections.map(({ id }) => id),
);

const menu = (scope: SettingsScope, workspaceRole?: WorkspaceRole) =>
  settingsNavigationSections(
    scope,
    settingsManifest[scope].filter(({ id }) => !deploymentSections.has(id)),
    workspaceRole,
  ).map(({ heading, registrations }) => [
    heading ?? null,
    registrations.map(({ label }) => label),
  ]);

describe("settings navigation", () => {
  it("shows only the settings features currently exposed in each menu", () => {
    expect(menu("personal")).toEqual([
      [null, ["Account", "Integrations & MCP", "Experimental Features"]],
      ["Usage", ["Model", "Orb", "Plugin usage"]],
      ["Agent", ["Instructions", "Mode Dial", "Model Routing"]],
      ["Library", ["Secrets & Env Vars", "Skills", "Plugins", "Triggers"]],
      ["Projects & Orbs", ["Project Defaults", "Orb Providers"]],
      [
        "Interface",
        ["Appearance", "Composer", "Keyboard Shortcuts", "Notifications"],
      ],
      ["Privacy & Security", ["Security"]],
    ]);

    expect(menu("workspace", "admin")).toEqual([
      [
        null,
        ["Workspace", "Members", "Integrations & MCP", "Usage", "Plugin usage"],
      ],
      ["Agent", ["Instructions", "Mode Dial", "Model Routing"]],
      [
        "Library",
        ["Secrets & Env Vars", "Skills", "Plugins", "External API Apps"],
      ],
      ["Projects & Orbs", ["Project Defaults", "Orb Providers"]],
      ["Interface", ["Composer"]],
    ]);

    // Members see shared configuration read-only; admin-only sections hide,
    // and so do the headings they leave empty.
    expect(menu("workspace", "member")).toEqual([
      [null, ["Workspace", "Members", "Integrations & MCP"]],
      ["Agent", ["Instructions"]],
      ["Library", ["Skills", "Plugins"]],
      ["Interface", ["Composer"]],
    ]);

    // Auditors don't see workspace Usage for now (owner, 2026-11-07).
    expect(menu("workspace", "auditor")[0]).toEqual([
      null,
      ["Workspace", "Members", "Integrations & MCP"],
    ]);
  });
});
