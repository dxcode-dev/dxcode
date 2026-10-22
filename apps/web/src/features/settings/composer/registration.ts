import { TextCursorInput } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import {
  ComposerSettings,
  WorkspaceComposerSettings,
} from "./composer-settings.js";

export const personalComposerSettingsSection: SettingsSectionRegistration = {
  id: "personal-composer",
  scope: "personal",
  group: "interface",
  slug: "composer",
  label: "Composer",
  title: "Composer",
  description: "What a New Thread starts with and dictation vocabulary.",
  icon: TextCursorInput,
  component: ComposerSettings,
};

export const workspaceComposerSettingsSection: SettingsSectionRegistration = {
  id: "workspace-composer",
  scope: "workspace",
  group: "interface",
  slug: "composer",
  label: "Composer",
  title: "Composer",
  description: "Dictation vocabulary for every member.",
  icon: TextCursorInput,
  component: WorkspaceComposerSettings,
};
