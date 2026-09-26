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
