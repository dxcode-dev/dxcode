import { SlidersHorizontal } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PersonalAdvancedSettings } from "./personal-advanced-settings.js";

export const personalAdvancedSettingsSection: SettingsSectionRegistration = {
  id: "personal-advanced",
  scope: "personal",
  slug: "advanced",
  label: "Advanced",
  title: "Advanced",
  description:
    "Set guidance for new top-level dx agents and review its data flow.",
  icon: SlidersHorizontal,
  component: PersonalAdvancedSettings,
};
