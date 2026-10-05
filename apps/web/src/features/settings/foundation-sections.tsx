import { personalAccountSettingsSection } from "./account/registration.js";
import { personalAdvancedSettingsSection } from "./advanced/registration.js";
import { appearanceSettingsSection } from "./appearance/registration.js";
import { workspaceApplicationsSettingsSection } from "./applications/registration.js";
import {
  personalCustomPluginsSettingsSection,
  workspaceCustomPluginsSettingsSection,
} from "./custom-plugins/registration.js";
import {
  personalEnvironmentVariablesSettingsSection,
  workspaceEnvironmentVariablesSettingsSection,
} from "./environment-variables/registration.js";
import { personalExperimentalFeaturesSettingsSection } from "./experimental-features/registration.js";
import {
  personalIntegrationsSettingsSection,
  workspaceIntegrationsSettingsSection,
} from "./integrations/registration.js";
import { keyboardShortcutsSettingsSection } from "./keyboard-shortcuts/registration.js";
import { personalSigningKeysSettingsSection } from "./keys/registration.js";
import { personalModeDialSettingsSection } from "./mode-dial/registration.js";
import {
  personalModelRoutingSettingsSection,
  workspaceModelRoutingSettingsSection,
} from "./model-routing/registration.js";
import {
  personalOrbProvidersSettingsSection,
  workspaceOrbProvidersSettingsSection,
} from "./orb-providers/registration.js";
import {
  personalPluginsSettingsSection,
  workspacePluginsSettingsSection,
} from "./plugins/registration.js";
import {
  personalProjectDefaultsSettingsSection,
  workspaceProjectDefaultsSettingsSection,
} from "./project-defaults/registration.js";
import { personalSecuritySettingsSection } from "./security/registration.js";
import {
  createSettingsManifest,
  type SettingsSectionRegistration,
} from "./settings-registration.js";
import {
  personalSkillsSettingsSection,
  workspaceSkillsSettingsSection,
} from "./skills/registration.js";
import { personalPluginTriggersSettingsSection } from "./triggers/registration.js";
import {
  personalPluginUsageSettingsSection,
  personalUsageSettingsSection,
  workspacePluginUsageSettingsSection,
  workspaceUsageSettingsSection,
} from "./usage/registration.js";
import { workspaceProfileSettingsSection } from "./workspace/registration.js";

export const foundationSettingsSections: ReadonlyArray<SettingsSectionRegistration> =
  [
    personalAccountSettingsSection,
    personalUsageSettingsSection,
    personalPluginUsageSettingsSection,
    personalEnvironmentVariablesSettingsSection,
    personalModelRoutingSettingsSection,
    personalModeDialSettingsSection,
    personalIntegrationsSettingsSection,
    personalSecuritySettingsSection,
    personalPluginsSettingsSection,
    personalOrbProvidersSettingsSection,
    personalCustomPluginsSettingsSection,
    personalPluginTriggersSettingsSection,
    personalSkillsSettingsSection,
    personalAdvancedSettingsSection,
    appearanceSettingsSection,
    personalExperimentalFeaturesSettingsSection,
    keyboardShortcutsSettingsSection,
    personalSigningKeysSettingsSection,
    personalProjectDefaultsSettingsSection,
    workspaceProfileSettingsSection,
    workspaceUsageSettingsSection,
    workspacePluginUsageSettingsSection,
    workspaceProjectDefaultsSettingsSection,
    workspaceEnvironmentVariablesSettingsSection,
    workspaceApplicationsSettingsSection,
    workspaceModelRoutingSettingsSection,
    workspaceIntegrationsSettingsSection,
    workspaceSkillsSettingsSection,
    workspacePluginsSettingsSection,
    workspaceOrbProvidersSettingsSection,
    workspaceCustomPluginsSettingsSection,
  ];

export const settingsManifest = createSettingsManifest(
  foundationSettingsSections,
);
