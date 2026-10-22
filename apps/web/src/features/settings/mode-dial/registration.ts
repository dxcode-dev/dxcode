import { Sliders } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ModeDialSettings } from "./mode-dial-settings.js";

export const personalModeDialSettingsSection = {
  id: "personal-mode-dial",
  scope: "personal",
  slug: "mode-dial",
  group: "agent",
  label: "Mode Dial",
  title: "Mode Dial",
  description:
    "Pin the model and reasoning effort behind each mode's main agent.",
  icon: Sliders,
  component: ModeDialSettings,
} satisfies SettingsSectionRegistration;

export const workspaceModeDialSettingsSection = {
  id: "workspace-mode-dial",
  scope: "workspace",
  slug: "mode-dial",
  group: "agent",
  label: "Mode Dial",
  title: "Mode Dial",
  description:
    "Pin each mode's main-agent model and reasoning effort for the workspace.",
  icon: Sliders,
  component: ModeDialSettings,
  adminOnly: true,
} satisfies SettingsSectionRegistration;
