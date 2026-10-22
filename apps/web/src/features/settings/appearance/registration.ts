import { Paintbrush } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { AppearanceSettings } from "./appearance-settings.js";

export const appearanceSettingsSection: SettingsSectionRegistration = {
  id: "personal-appearance",
  scope: "personal",
  slug: "appearance",
  group: "interface",
  label: "Appearance",
  title: "Appearance",
  description: "Choose how dx looks on all your devices.",
  icon: Paintbrush,
  component: AppearanceSettings,
};
