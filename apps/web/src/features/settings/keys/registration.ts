import { KeyRound } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { SigningKeysSettings } from "./signing-keys-settings.js";

export const personalSigningKeysSettingsSection = {
  id: "personal-signing-keys",
  scope: "personal",
  slug: "keys",
  label: "Signing Keys",
  title: "Signing Keys",
  description:
    "Sign dx-created Git commits and manage public verification keys.",
  icon: KeyRound,
  component: SigningKeysSettings,
} satisfies SettingsSectionRegistration;
