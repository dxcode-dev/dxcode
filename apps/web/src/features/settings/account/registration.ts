import { UserRound } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PersonalAccountSettings } from "./account-settings.js";

export const personalAccountSettingsSection: SettingsSectionRegistration = {
  id: "personal-account",
  scope: "personal",
  group: "top-level",
  label: "Account",
  title: "Account",
  description: "Manage your local profile and review your signed-in identity.",
  icon: UserRound,
  component: PersonalAccountSettings,
};
