import { Users } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { MembersSettings } from "./members-settings.js";

export const workspaceMembersSettingsSection = {
  id: "workspace-members",
  scope: "workspace",
  slug: "members",
  label: "Members",
  title: "Members",
  description: "People in this workspace, their roles, and invite links.",
  icon: Users,
  component: MembersSettings,
} satisfies SettingsSectionRegistration;
