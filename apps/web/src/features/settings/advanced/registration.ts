import { SquarePen } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PersonalAdvancedSettings } from "./personal-advanced-settings.js";

export const personalAdvancedSettingsSection: SettingsSectionRegistration = {
  id: "personal-advanced",
  scope: "personal",
  slug: "instructions",
  group: "agent",
  label: "Instructions",
  title: "Instructions",
  description: "Personal guidance for the top-level agent in every new Thread.",
  icon: SquarePen,
  component: PersonalAdvancedSettings,
};
