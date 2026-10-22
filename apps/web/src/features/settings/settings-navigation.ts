import type { SettingsScope, WorkspaceRole } from "@dx/domain";
import {
  type SettingsNavigationGroup,
  type SettingsSectionRegistration,
  settingsNavigationGroups,
} from "./settings-registration.js";

const hiddenNavigationIds: Readonly<
  Record<SettingsScope, ReadonlySet<string>>
> = {
  personal: new Set([
    "personal-usage",
    "personal-plugin-usage",
    "personal-custom-plugins",
    "personal-triggers",
    "personal-experimental-features",
    "personal-signing-keys",
  ]),
  workspace: new Set([
    "workspace-usage",
    "workspace-plugin-usage",
    "workspace-custom-plugins",
  ]),
};

export const isWorkspaceAdmin = (role: WorkspaceRole | undefined) =>
  role === "owner" || role === "admin";

export interface SettingsNavigationSection {
  readonly group: SettingsNavigationGroup;
  /** Absent for the top-level sections that lead the menu. */
  readonly heading?: string;
  readonly registrations: ReadonlyArray<SettingsSectionRegistration>;
}

/**
 * A scope's menu: top-level sections first, then each group under its heading
 * in `settingsNavigationGroups` order. Hidden sections, and admin-only
 * workspace sections until the viewer is known to be an owner or admin, are
 * left out, and a group with nothing left has no heading.
 */
export const settingsNavigationSections = (
  scope: SettingsScope,
  registrations: ReadonlyArray<SettingsSectionRegistration>,
  workspaceRole?: WorkspaceRole,
): ReadonlyArray<SettingsNavigationSection> => {
  const visible = registrations.filter(
    (registration) =>
      !hiddenNavigationIds[scope].has(registration.id) &&
      (scope === "personal" ||
        registration.adminOnly !== true ||
        isWorkspaceAdmin(workspaceRole)),
  );
  return [
    {
      group: "top-level" as const,
      registrations: visible.filter(
        (registration) => registration.group === "top-level",
      ),
    },
    ...settingsNavigationGroups.map((group) => ({
      group: group.id,
      heading: group.label,
      registrations: visible.filter(
        (registration) => registration.group === group.id,
      ),
    })),
  ].filter((section) => section.registrations.length > 0);
};
