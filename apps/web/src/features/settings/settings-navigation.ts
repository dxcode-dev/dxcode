import type { SettingsScope } from "@dx/domain";
import type { SettingsSectionRegistration } from "./settings-registration.js";

const hiddenNavigationIds: Readonly<
  Record<SettingsScope, ReadonlySet<string>>
> = {
  personal: new Set([
    "personal-usage",
    "personal-mcp-servers",
    "personal-security",
    "personal-plugins",
    "personal-triggers",
    "personal-skills",
    "personal-experimental-features",
    "personal-signing-keys",
    "personal-project-defaults",
  ]),
  workspace: new Set([
    "workspace-usage",
    "workspace-project-defaults",
    "workspace-applications",
    "workspace-model-routing",
    "workspace-mcp-servers",
    "workspace-skills",
    "workspace-plugins",
  ]),
};

export const settingsNavigationRegistrations = (
  scope: SettingsScope,
  registrations: ReadonlyArray<SettingsSectionRegistration>,
): ReadonlyArray<SettingsSectionRegistration> =>
  registrations.filter(
    (registration) => !hiddenNavigationIds[scope].has(registration.id),
  );
