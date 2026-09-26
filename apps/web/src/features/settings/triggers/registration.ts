import { Webhook } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { PluginTriggersSettings } from "./triggers-settings.js";

export const personalPluginTriggersSettingsSection = {
  id: "personal-triggers",
  slug: "triggers",
  scope: "personal",
  label: "Triggers",
  title: "Plugin Triggers",
  description: "Manage authenticated webhooks and durable plugin deliveries.",
  icon: Webhook,
  component: PluginTriggersSettings,
} satisfies SettingsSectionRegistration;
