import { Library } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { SkillsSettings } from "./skills-settings.js";

const common = {
  slug: "skills",
  label: "Skills",
  title: "Skills",
  description: "Review and manage versioned instruction bundles and resources.",
  icon: Library,
  component: SkillsSettings,
} as const;

export const personalSkillsSettingsSection = {
  ...common,
  id: "personal-skills",
  scope: "personal",
} satisfies SettingsSectionRegistration;

export const workspaceSkillsSettingsSection = {
  ...common,
  id: "workspace-skills",
  scope: "workspace",
} satisfies SettingsSectionRegistration;
