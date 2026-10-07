import type { SettingsScope, WorkspaceRole } from "@dx/domain";
import type { SettingsSectionRegistration } from "./settings-registration.js";

const hiddenNavigationIds: Readonly<
  Record<SettingsScope, ReadonlySet<string>>
> = {
  personal: new Set([
    "personal-usage",
    "personal-plugin-usage",
    "personal-security",
    "personal-custom-plugins",
    "personal-triggers",
    "personal-skills",
    "personal-experimental-features",
    "personal-signing-keys",
    "personal-project-defaults",
  ]),
  workspace: new Set([
    "workspace-usage",
    "workspace-plugin-usage",
    "workspace-project-defaults",
    "workspace-applications",
    "workspace-skills",
    "workspace-custom-plugins",
  ]),
};

export const isWorkspaceAdmin = (role: WorkspaceRole | undefined) =>
  role === "owner" || role === "admin";

/**
 * Sections shown in a scope's menu. Admin-only workspace sections appear only
 * once the viewer is known to be an owner or admin.
 */
export const settingsNavigationRegistrations = (
  scope: SettingsScope,
  registrations: ReadonlyArray<SettingsSectionRegistration>,
  workspaceRole?: WorkspaceRole,
): ReadonlyArray<SettingsSectionRegistration> =>
  registrations.filter(
    (registration) =>
      !hiddenNavigationIds[scope].has(registration.id) &&
      (scope === "personal" ||
        registration.adminOnly !== true ||
        isWorkspaceAdmin(workspaceRole)),
  );
