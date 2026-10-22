import { GitBranch } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ProjectDefaultsSettings } from "./project-defaults-settings.js";

const common = {
  slug: "projects",
  group: "projects-orbs",
  label: "Project Defaults",
  title: "Project Defaults",
  description: "Commit author and Orb size for new projects.",
  icon: GitBranch,
  component: ProjectDefaultsSettings,
} as const;

export const personalProjectDefaultsSettingsSection = {
  ...common,
  id: "personal-project-defaults",
  scope: "personal",
} satisfies SettingsSectionRegistration;

export const workspaceProjectDefaultsSettingsSection = {
  ...common,
  id: "workspace-project-defaults",
  scope: "workspace",
  adminOnly: true,
} satisfies SettingsSectionRegistration;
