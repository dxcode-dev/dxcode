import { useQuery } from "@tanstack/react-query";
import { PluginIcon } from "../../shared/ui/plugin-icon.js";
import { pluginViewsCatalogQueryOptions } from "./plugin-views-queries.js";

/**
 * A plugin Thread type's icon on a Thread row. Loaded only for a row
 * with a type, from the views catalog the palette and composer share; a
 * type its plugin no longer offers shows its letter tile.
 */
export function PluginThreadTypeIcon({
  threadType,
}: {
  /** `<plugin>/<type>`, as the Thread stores it. */
  readonly threadType: string;
}) {
  const type = useQuery({
    ...pluginViewsCatalogQueryOptions(),
    select: (data) => data.threadTypes.find(({ ref }) => ref === threadType),
  }).data;
  const name = type?.title ?? threadType.slice(threadType.indexOf("/") + 1);
  return (
    <PluginIcon
      name={name}
      {...(type?.icon === undefined ? {} : { item: type.icon })}
      size={16}
      className="thread-pin-icon thread-type-icon"
      label={type === undefined ? name : `${type.title} · ${type.pluginTitle}`}
    />
  );
}
