import { Blocks } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { CustomPluginsSettings } from "./custom-plugins-settings.js";

// Imported-bundle plugins. Hidden from navigation; "Plugins" means the
// first-party plugin page (see ../plugins/registration.ts).
const common = {
  slug: "custom-plugins",
  label: "Custom plugins",
  title: "Custom plugins",
  description: "Review, trust, and manage bounded imported plugin bundles.",
  icon: Blocks,
  component: CustomPluginsSettings,
} as const;

export const personalCustomPluginsSettingsSection = {
  ...common,
  id: "personal-custom-plugins",
  scope: "personal",
} satisfies SettingsSectionRegistration;
export const workspaceCustomPluginsSettingsSection = {
  ...common,
  id: "workspace-custom-plugins",
  scope: "workspace",
  adminOnly: true,
} satisfies SettingsSectionRegistration;
