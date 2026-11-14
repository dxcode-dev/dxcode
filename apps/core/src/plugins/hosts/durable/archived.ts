import type { PluginArchivedMode, PluginBundleCode } from "@dx/domain";

/**
 * What the durable host's objects do in an archived Thread. They keep
 * running when anything of the plugin's that a Thread shows is `live`: the
 * plugin itself, one of its panes, or one of its tabs (a Thread type draws
 * one of its tabs). Otherwise the plugin's own setting decides (`hide` when
 * absent), and its jobs pause. `effectiveArchivedMode` then grants `live`
 * only to a trusted tier with this host.
 */
export const durableArchivedMode = (
  code: Pick<PluginBundleCode, "archivedThreads" | "panes" | "views">,
): PluginArchivedMode =>
  code.archivedThreads === "live" ||
  (code.panes ?? []).some((pane) => pane.archivedThreads === "live") ||
  (code.views?.tabs ?? []).some((tab) => tab.archivedThreads === "live")
    ? "live"
    : (code.archivedThreads ?? "hide");
