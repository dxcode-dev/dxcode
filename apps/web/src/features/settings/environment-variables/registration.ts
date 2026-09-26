import { KeyRound } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { EnvironmentVariablesSettings } from "./environment-variables-settings.js";

const common = {
  slug: "environment-variables",
  label: "Secrets & Env Vars",
  title: "Secrets & Environment Variables",
  description: "Manage values available to your dx Orbs and Terminal shells.",
  icon: KeyRound,
  component: EnvironmentVariablesSettings,
} as const;

export const personalEnvironmentVariablesSettingsSection = {
  ...common,
  id: "personal-environment-variables",
  scope: "personal",
} satisfies SettingsSectionRegistration;
export const workspaceEnvironmentVariablesSettingsSection = {
  ...common,
  id: "workspace-environment-variables",
  scope: "workspace",
} satisfies SettingsSectionRegistration;
