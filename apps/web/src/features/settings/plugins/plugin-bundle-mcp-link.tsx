import { Link } from "@tanstack/react-router";
import { settingsNavigationState } from "../../../shared/navigation/settings-return.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import type { SettingsSectionProps } from "../settings-registration.js";

/** Opens the MCP servers a bundle installed, where their tools are reviewed. */
export function McpSettingsLink({
  workspace,
  scope,
  settingsReturnTo,
}: Pick<SettingsSectionProps, "workspace" | "settingsReturnTo"> & {
  readonly scope: "personal" | "workspace";
}) {
  const state = settingsNavigationState(settingsReturnTo);
  if (scope === "workspace" && workspace !== undefined) {
    return (
      <Link
        to="/workspaces/$workspaceSlug/$section"
        params={{
          workspaceSlug: workspace.shortName,
          section: "integrations",
        }}
        state={state}
        className={buttonVariants({ variant: "outline", size: "xs" })}
      >
        Review MCP tools
      </Link>
    );
  }
  return (
    <Link
      to="/settings/$section"
      params={{ section: "integrations" }}
      state={state}
      className={buttonVariants({ variant: "outline", size: "xs" })}
    >
      Review MCP tools
    </Link>
  );
}
