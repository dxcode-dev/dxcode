import { PlugZap } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { IntegrationsSettings } from "./integrations-settings.js";

const common = {
  slug: "integrations",
  label: "Integrations",
  title: "Integrations",
  description: "Connect and manage GitHub source control.",
  icon: PlugZap,
  component: IntegrationsSettings,
} as const;

export const personalIntegrationsSettingsSection = {
  ...common,
  id: "personal-integrations",
  scope: "personal",
} satisfies SettingsSectionRegistration;
