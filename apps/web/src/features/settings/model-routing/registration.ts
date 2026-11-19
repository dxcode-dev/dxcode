import { Navigate } from "@tanstack/react-router";
import { Route } from "lucide-react";
import { createElement } from "react";
import {
  type SettingsSectionProps,
  type SettingsSectionRegistration,
  settingsPath,
} from "../settings-registration.js";

/**
 * Model Routing's old address: its connections are the first part of
 * Settings → Models now, so the address opens that page.
 */
const OpenModels = ({ workspaceSlug }: SettingsSectionProps) =>
  createElement(Navigate, {
    to:
      workspaceSlug === undefined
        ? settingsPath({ scope: "personal", section: "models" })
        : settingsPath({
            scope: "workspace",
            workspaceSlug,
            section: "models",
          }),
    replace: true,
  });

const common = {
  slug: "model-routing",
  group: "agent",
  label: "Model Routing",
  title: "Models & Routing",
  description: "Opens Settings → Models, where connections are listed first.",
  icon: Route,
  component: OpenModels,
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
  adminOnly: true,
} satisfies SettingsSectionRegistration;
