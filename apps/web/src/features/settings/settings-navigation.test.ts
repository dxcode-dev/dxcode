import type { SettingsScope, WorkspaceRole } from "@dx/domain";
import { describe, expect, it } from "vitest";
import { settingsManifest } from "./foundation-sections.js";
import { settingsNavigationSections } from "./settings-navigation.js";

const menu = (scope: SettingsScope, workspaceRole?: WorkspaceRole) =>
  settingsNavigationSections(scope, settingsManifest[scope], workspaceRole).map(
    ({ heading, registrations }) => [
      heading ?? null,
      registrations.map(({ label }) => label),
    ],
  );

describe("settings navigation", () => {
  it("shows only the settings features currently exposed in each menu", () => {
    expect(menu("personal")).toEqual([
      [null, ["Account", "Integrations & MCP"]],
      ["Agent", ["Instructions", "Mode Dial", "Model Routing"]],
      ["Library", ["Secrets & Env Vars", "Skills", "Plugins"]],
      ["Projects & Orbs", ["Project Defaults", "Orb Providers"]],
      [
        "Interface",
        ["Appearance", "Composer", "Keyboard Shortcuts", "Notifications"],
      ],
      ["Privacy & Security", ["Security"]],
    ]);

    expect(menu("workspace", "admin")).toEqual([
      [null, ["Workspace", "Members", "Integrations & MCP"]],
      ["Agent", ["Mode Dial", "Model Routing"]],
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
      ["Library", ["Skills", "Plugins"]],
      ["Interface", ["Composer"]],
    ]);
  });
});
