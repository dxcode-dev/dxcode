import { Blocks } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PluginsSettings } from "./plugins-settings.js";

// First-party plugins (Search, Speech, …) driven by the Core registry.
const common = {
  slug: "plugins",
  label: "Plugins",
  title: "Plugins",
  description:
    "Turn first-party plugins on or off and choose their provider keys.",
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
