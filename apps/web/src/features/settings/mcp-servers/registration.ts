import { Blocks } from "lucide-react";
import type { SettingsSectionRegistration } from "../settings-registration.js";
import { McpServersSettings } from "./mcp-servers-settings.js";

const common = {
  slug: "mcp-servers",
  label: "MCP",
  title: "MCP Servers",
  description: "Review and connect tools from remote MCP servers.",
  icon: Blocks,
  component: McpServersSettings,
} as const;

export const personalMcpServersSettingsSection = {
  ...common,
  id: "personal-mcp-servers",
  scope: "personal",
} satisfies SettingsSectionRegistration;

export const workspaceMcpServersSettingsSection = {
  ...common,
  id: "workspace-mcp-servers",
  scope: "workspace",
} satisfies SettingsSectionRegistration;
