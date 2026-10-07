import { OrbIcon } from "../../../shared/ui/orb-icon.js";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { OrbProvidersSettings } from "./orb-providers-settings.js";

// Orb (Execution) providers: the deployment's, plus bring-your-own keys for
// key-based providers such as E2B.
const common = {
  slug: "orb-providers",
  label: "Orb Providers",
  title: "Orb Providers",
  description: "Choose which accounts run your Orbs.",
  icon: OrbIcon,
  component: OrbProvidersSettings,
} as const;

export const personalOrbProvidersSettingsSection = {
  ...common,
  id: "personal-orb-providers",
  scope: "personal",
} satisfies SettingsSectionRegistration;
export const workspaceOrbProvidersSettingsSection = {
  ...common,
  id: "workspace-orb-providers",
  scope: "workspace",
  adminOnly: true,
} satisfies SettingsSectionRegistration;
