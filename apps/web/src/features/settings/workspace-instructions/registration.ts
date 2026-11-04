import { SquarePen } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { WorkspaceInstructionsSettings } from "./workspace-instructions-settings.js";

export const workspaceInstructionsSettingsSection = {
  id: "workspace-instructions",
  scope: "workspace",
  slug: "instructions",
  group: "agent",
  label: "Instructions",
  title: "Instructions",
  description: "Guidance every member's top-level agent receives.",
  icon: SquarePen,
  component: WorkspaceInstructionsSettings,
} satisfies SettingsSectionRegistration;
