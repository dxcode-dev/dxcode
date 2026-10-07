import { Blocks, ChartSpline } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import {
  PersonalPluginUsageSettings,
  WorkspacePluginUsageSettings,
} from "./plugin-usage.js";
import { PersonalUsageSettings } from "./usage-settings.js";
import { WorkspaceUsageSettings } from "./workspace-usage-settings.js";

export const personalUsageSettingsSection = {
  id: "personal-usage",
  scope: "personal",
  slug: "usage",
  label: "Usage",
  title: "Usage",
  description:
    "Inspect content-free model, tool, and runner activity attributed to your Threads.",
  icon: ChartSpline,
  component: PersonalUsageSettings,
} satisfies SettingsSectionRegistration;

export const workspaceUsageSettingsSection = {
  id: "workspace-usage",
  scope: "workspace",
  adminOnly: true,
  slug: "usage",
  label: "Usage",
  title: "Workspace usage",
  description:
    "Review content-free workspace aggregates and exceptional private-access audit.",
  icon: ChartSpline,
  component: WorkspaceUsageSettings,
} satisfies SettingsSectionRegistration;

// Plugin usage: reachable by URL only (hidden in settings-navigation.ts)
// until the owner decides how usage is presented.
const pluginUsage = {
  slug: "plugin-usage",
  label: "Plugin usage",
  title: "Plugin usage",
  description:
    "Provider calls by plugin, provider, and capability, and the key that paid for them.",
  icon: Blocks,
} as const;

export const personalPluginUsageSettingsSection = {
  ...pluginUsage,
  id: "personal-plugin-usage",
  scope: "personal",
  component: PersonalPluginUsageSettings,
} satisfies SettingsSectionRegistration;

export const workspacePluginUsageSettingsSection = {
  ...pluginUsage,
  id: "workspace-plugin-usage",
  scope: "workspace",
  adminOnly: true,
  component: WorkspacePluginUsageSettings,
} satisfies SettingsSectionRegistration;
