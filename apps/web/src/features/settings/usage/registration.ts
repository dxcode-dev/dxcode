import { ChartSpline } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
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
  slug: "usage",
  label: "Usage",
  title: "Workspace usage",
  description:
    "Review content-free workspace aggregates and exceptional private-access audit.",
  icon: ChartSpline,
  component: WorkspaceUsageSettings,
} satisfies SettingsSectionRegistration;
