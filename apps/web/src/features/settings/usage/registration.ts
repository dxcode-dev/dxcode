import { Blocks, ChartSpline, Orbit } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { OrbUsageSettings } from "./orb-usage.js";
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
  group: "usage",
  label: "Model",
  title: "Model Usage",
  description: "Tokens and estimated cost by day, model, and Thread.",
  icon: ChartSpline,
  component: PersonalUsageSettings,
} satisfies SettingsSectionRegistration;

export const personalOrbUsageSettingsSection = {
  id: "personal-orb-usage",
  scope: "personal",
  slug: "orbs",
  group: "usage",
  label: "Orb",
  title: "Orb Usage",
  description:
    "Running and recently paused Orbs, with their time in the last 24 hours.",
  icon: Orbit,
  component: OrbUsageSettings,
} satisfies SettingsSectionRegistration;

export const workspaceUsageSettingsSection = {
  id: "workspace-usage",
  scope: "workspace",
  group: "top-level",
  adminOnly: true,
  slug: "usage",
  label: "Usage",
  title: "Workspace Usage",
  description:
    "The workspace's tokens and estimated cost by model, member, and Thread.",
  icon: ChartSpline,
  component: WorkspaceUsageSettings,
} satisfies SettingsSectionRegistration;

// Plugin usage: under Usage for a person, beside Usage for a workspace.
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
  group: "usage",
  component: PersonalPluginUsageSettings,
} satisfies SettingsSectionRegistration;

export const workspacePluginUsageSettingsSection = {
  ...pluginUsage,
  id: "workspace-plugin-usage",
  scope: "workspace",
  group: "top-level",
  adminOnly: true,
  component: WorkspacePluginUsageSettings,
} satisfies SettingsSectionRegistration;
