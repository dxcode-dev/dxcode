import type { FirstPartyPluginData } from "./plugins-queries.js";

type Scope = "personal" | "workspace";

/** Always-on core capabilities (Code) are not plugins to the user. */
export const listedPlugins = (plugins: ReadonlyArray<FirstPartyPluginData>) =>
  plugins.filter(({ alwaysOn }) => !alwaysOn);

/** The toggle shows whether this scope's members get the plugin at all. */
export const pluginSwitch = (plugin: FirstPartyPluginData, scope: Scope) => {
  const lockedByWorkspace =
    scope === "personal" &&
    plugin.inherited.workspace?.enablement === "disabled";
  return {
    checked: !lockedByWorkspace && plugin.effective.status !== "disabled",
    locked: lockedByWorkspace,
  };
};

/** A few words beside the name, only when the plugin cannot work as shown. */
export const pluginHint = (
  plugin: FirstPartyPluginData,
  scope: Scope,
): string | undefined => {
  if (pluginSwitch(plugin, scope).locked) return "Disabled by your workspace";
  if (plugin.effective.status === "no-provider") return "Needs an API key";
  return undefined;
};

/** Where the key comes from today, shown inside the empty key field. */
export const credentialPlaceholder = (
  plugin: FirstPartyPluginData,
  providerId: string,
  scope: Scope,
) => {
  if (plugin.configuration?.providerId === providerId)
    return "Key saved. Enter a new key to replace it.";
  if (scope === "personal" && plugin.inherited.workspace?.providerId != null)
    return "Using the workspace key";
  if (plugin.inherited.deployment.providerId === "fixture")
    return "Local development uses a fixture";
  if (plugin.inherited.deployment.providerId === providerId)
    return "Using the deployment key";
  return "Paste an API key";
};
