import { Route } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ModelRoutingSettings } from "./model-routing-settings.js";

const common = {
  slug: "model-routing",
  label: "Model Routing",
  title: "Model Routing",
  description:
    "Provider connections, subscriptions, and the modes-to-model routing graph.",
  icon: Route,
  component: ModelRoutingSettings,
} as const;

export const personalModelRoutingSettingsSection = {
  ...common,
  id: "personal-model-routing",
  scope: "personal",
} satisfies SettingsSectionRegistration;

export const workspaceModelRoutingSettingsSection = {
  ...common,
  id: "workspace-model-routing",
  scope: "workspace",
  description:
    "Custom URL connections every member's Threads can use after their own.",
  adminOnly: true,
} satisfies SettingsSectionRegistration;
