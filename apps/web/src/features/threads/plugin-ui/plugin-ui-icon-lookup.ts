import type { PluginIconSetData, PluginThreadUiData } from "@dx/api";

/** Finds a plugin's icon in the Thread's plugin UI data. */

export const iconByName = (
  data: Pick<PluginThreadUiData, "plugins"> | undefined,
  name: string,
): PluginIconSetData | undefined =>
  data?.plugins?.find((plugin) => plugin.name === name)?.icon;

/**
 * An item's plugin icon: by the manifest name it carries, which two plugins
 * never share; by its display name only from older servers that send none.
 */
export const iconForItem = (
  data: Pick<PluginThreadUiData, "plugins"> | undefined,
  item: { readonly plugin: string; readonly pluginName?: string | undefined },
): PluginIconSetData | undefined =>
  item.pluginName === undefined
    ? data?.plugins?.find((plugin) => plugin.title === item.plugin)?.icon
    : iconByName(data, item.pluginName);
