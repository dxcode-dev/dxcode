import { AppWindow } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ExternalApiApplicationsSettings } from "./external-api-applications-settings.js";

export const workspaceApplicationsSettingsSection: SettingsSectionRegistration =
  {
    id: "workspace-applications",
    scope: "workspace",
    slug: "applications",
    label: "Applications",
    title: "External API Applications",
    description:
      "Manage workspace-owned machine clients for stable dx product APIs.",
    icon: AppWindow,
    component: ExternalApiApplicationsSettings,
  };
