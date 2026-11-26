/**
 * How long one call into a plugin's code may run. An install (personal or
 * workspace) gets what its installer approved: 5 minutes. A plugin a
 * repository carries, which nobody installed, gets 60 seconds. These replace
 * the per-tier limits (tasks/plugins-next.md decision 3).
 */
export const PLUGIN_INSTALL_CALL_MS = 300_000;
export const PLUGIN_REPOSITORY_CALL_MS = 60_000;

export const pluginCallLimitMs = (
  scope: "personal" | "workspace" | "repository",
) =>
  scope === "repository" ? PLUGIN_REPOSITORY_CALL_MS : PLUGIN_INSTALL_CALL_MS;
