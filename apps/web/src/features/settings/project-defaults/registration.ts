import { GitBranch } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ProjectDefaultsSettings } from "./project-defaults-settings.js";

const common = {
  slug: "projects",
  label: "Project Defaults",
  title: "Project Defaults",
  description: "Set Git and runner defaults snapshotted by new projects.",
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
} satisfies SettingsSectionRegistration;
