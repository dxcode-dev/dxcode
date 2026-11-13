import { Sparkles } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ModeDialSettings } from "./mode-dial-settings.js";

export const personalModeDialSettingsSection = {
  id: "personal-mode-dial",
  scope: "personal",
  slug: "models",
  group: "agent",
  label: "Models",
  title: "Models",
  description:
    "The Recommended model and effort new Threads start on, and the models older mode Threads run on.",
  icon: Sparkles,
  component: ModeDialSettings,
} satisfies SettingsSectionRegistration;

export const workspaceModeDialSettingsSection = {
  id: "workspace-mode-dial",
  scope: "workspace",
  slug: "models",
  group: "agent",
  label: "Models",
  title: "Models",
  description:
    "The Recommended model and effort everyone in the workspace starts new Threads on.",
  icon: Sparkles,
  component: ModeDialSettings,
  adminOnly: true,
} satisfies SettingsSectionRegistration;
