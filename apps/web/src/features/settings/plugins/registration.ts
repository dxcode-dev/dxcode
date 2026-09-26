import { Blocks } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PluginsSettings } from "./plugins-settings.js";

const common = {
  slug: "plugins",
  label: "Plugins",
  title: "Plugins",
  description: "Review, trust, and manage bounded first-party plugin bundles.",
  icon: Blocks,
  component: PluginsSettings,
} as const;

export const personalPluginsSettingsSection = {
  ...common,
  id: "personal-plugins",
  scope: "personal",
} satisfies SettingsSectionRegistration;
export const workspacePluginsSettingsSection = {
  ...common,
  id: "workspace-plugins",
  scope: "workspace",
} satisfies SettingsSectionRegistration;
