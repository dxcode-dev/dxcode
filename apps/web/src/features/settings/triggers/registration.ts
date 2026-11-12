import { Webhook } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PluginTriggersSettings } from "./triggers-settings.js";

export const personalPluginTriggersSettingsSection = {
  id: "personal-triggers",
  slug: "triggers",
  group: "library",
  scope: "personal",
  label: "Triggers",
  title: "Triggers",
  description: "Webhook URLs that send deliveries to your plugins' code.",
  icon: Webhook,
  component: PluginTriggersSettings,
} satisfies SettingsSectionRegistration;
