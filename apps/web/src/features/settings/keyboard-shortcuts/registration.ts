import { Keyboard } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings.js";

export const keyboardShortcutsSettingsSection: SettingsSectionRegistration = {
  id: "personal-keyboard-shortcuts",
  scope: "personal",
  slug: "keyboard-shortcuts",
  label: "Keyboard Shortcuts",
  title: "Keyboard Shortcuts",
  description: "Customize keyboard shortcuts on this device.",
  icon: Keyboard,
  component: KeyboardShortcutsSettings,
};
