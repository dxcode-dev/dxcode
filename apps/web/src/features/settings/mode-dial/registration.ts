import { Sliders } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ModeDialSettings } from "./mode-dial-settings.js";

export const personalModeDialSettingsSection = {
  id: "personal-mode-dial",
  scope: "personal",
  slug: "mode-dial",
  label: "Mode Dial",
  title: "Mode Dial",
  description:
    "Tune which model and thinking level each mode uses for the main agent.",
  icon: Sliders,
  component: ModeDialSettings,
} satisfies SettingsSectionRegistration;

export const workspaceModeDialSettingsSection = {
  id: "workspace-mode-dial",
  scope: "workspace",
  slug: "mode-dial",
  label: "Mode Dial",
  title: "Mode Dial",
  description:
    "Default model and thinking level for each mode, for members who have not tuned it.",
  icon: Sliders,
  component: ModeDialSettings,
  adminOnly: true,
} satisfies SettingsSectionRegistration;
