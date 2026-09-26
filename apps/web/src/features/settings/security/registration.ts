import { ShieldCheck } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PersonalSecuritySettings } from "./security-settings.js";

export const personalSecuritySettingsSection = {
  id: "personal-security",
  scope: "personal",
  slug: "security",
  label: "Security",
  title: "Security",
  description: "Manage API access and browser sessions.",
  icon: ShieldCheck,
  component: PersonalSecuritySettings,
} as const satisfies SettingsSectionRegistration;
