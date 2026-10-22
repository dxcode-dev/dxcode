import { Keyboard } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { KeyboardShortcutsSection } from "./keyboard-shortcuts-settings.js";

export const keyboardShortcutsSettingsSection: SettingsSectionRegistration = {
  id: "personal-keyboard-shortcuts",
  scope: "personal",
  slug: "keyboard-shortcuts",
  group: "interface",
  label: "Keyboard Shortcuts",
  title: "Keyboard Shortcuts",
  description:
    "Customize keyboard shortcuts in dx. They are stored on this device.",
  icon: Keyboard,
  component: KeyboardShortcutsSection,
};
