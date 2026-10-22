import { Braces } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { ExternalApiApplicationsSettings } from "./external-api-applications-settings.js";

export const workspaceApplicationsSettingsSection: SettingsSectionRegistration =
  {
    id: "workspace-applications",
    scope: "workspace",
    adminOnly: true,
    slug: "applications",
    group: "library",
    label: "External API Apps",
    title: "External API Apps",
    description:
      "Machine clients that call dx's Project and Thread APIs with a client ID and secret.",
    icon: Braces,
    component: ExternalApiApplicationsSettings,
  };
