import { Library } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { SkillsSettings } from "./skills-settings.js";

const common = {
  slug: "skills",
  group: "library",
  label: "Skills",
  title: "Skills",
  description: "Reusable workflows and knowledge that dx loads in new Threads.",
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
