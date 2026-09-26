import { Building2 } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { WorkspaceProfileSettings } from "./workspace-profile-settings.js";

export const workspaceProfileSettingsSection: SettingsSectionRegistration = {
  id: "workspace-root",
  scope: "workspace",
  label: "Workspace",
  title: "Workspace",
  description: "Manage this workspace's profile and stable identity.",
  icon: Building2,
  component: WorkspaceProfileSettings,
};
