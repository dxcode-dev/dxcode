import type { Bindings } from "../../http/types.js";
import { listThreadCodePluginInstalls } from "../worker-host/resolve.js";
import { pluginTier, tierStreams } from "./tier.js";

export type StreamCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "uninstalled"
        | "no-pane-grant"
        | "tier"
        | "archived"
        | "check-failed";
    };

/**
 * Whether a stream may go on: the plugin is still installed for the Thread
 * with the pane grant, at a tier with stream bandwidth, and the Thread is
 * not archived (unless the plugin keeps `archivedThreads: "live"`). Runs
 * once a minute per open stream, never per message.
 */
export const revalidateStream = async (
  bindings: Bindings,
  meta: { readonly threadId: string; readonly pluginId: string },
): Promise<StreamCheck> => {
  const db = bindings.DB;
  if (db === undefined) return { ok: true };
  const [installs, thread] = await Promise.all([
    listThreadCodePluginInstalls(db, meta.threadId),
    db
      .prepare("SELECT archived_at FROM threads WHERE id = ?")
      .bind(meta.threadId)
      .first<{ archived_at: number | null }>(),
  ]);
  const install = installs.find(({ pluginId }) => pluginId === meta.pluginId);
  if (install === undefined || thread === null)
    return { ok: false, reason: "uninstalled" };
  if (!(install.code.permissions.ui ?? []).includes("pane"))
    return { ok: false, reason: "no-pane-grant" };
  if (!tierStreams(bindings, pluginTier(install)))
    return { ok: false, reason: "tier" };
  const live =
    (install.code as { readonly archivedThreads?: string }).archivedThreads ===
    "live";
  if (thread.archived_at !== null && !live)
    return { ok: false, reason: "archived" };
  return { ok: true };
};
