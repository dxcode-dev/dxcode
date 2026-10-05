import { PlugZap } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { IntegrationsSettings } from "./integrations-settings.js";

const common = {
  slug: "integrations",
  label: "MCP & Integrations",
  title: "MCP & Integrations",
  description: "Connect source control and MCP servers.",
  icon: PlugZap,
  component: IntegrationsSettings,
} as const;

export const personalIntegrationsSettingsSection = {
  ...common,
  id: "personal-integrations",
  scope: "personal",
} satisfies SettingsSectionRegistration;

export const workspaceIntegrationsSettingsSection = {
  ...common,
  id: "workspace-integrations",
  scope: "workspace",
} satisfies SettingsSectionRegistration;
