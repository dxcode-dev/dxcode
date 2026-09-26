import { UserRound } from "lucide-react";
import { PersonalAccountSettings } from "./account-settings.js";
import type { SettingsSectionRegistration } from "../settings-registration.js";

export const personalAccountSettingsSection: SettingsSectionRegistration = {
  id: "personal-account",
  scope: "personal",
  label: "Account",
  title: "Account",
  description: "Manage your local profile and review your signed-in identity.",
  icon: UserRound,
  component: PersonalAccountSettings,
};
