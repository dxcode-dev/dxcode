import { Option } from "effect";
import { activeMemberSql } from "../../../settings/members/membership-sql.js";
import { pluginRunsForOwnerSql } from "../../../settings/plugins/bundles/overlap.js";
import { storedIconSet } from "../../icons/store.js";
import {
  installedPluginTier,
  installTrustColumns,
  installTrustFromRow,
} from "../../trust/resolve-tier.js";
import type { PluginInstallRecord } from "../../worker-host/host.js";
import { decodePluginCode } from "../../worker-host/worker.js";
import { durableArchivedMode } from "./archived.js";

/**
 * What the Durable Object reads before it runs code it was not called for
 * (an alarm, a watch message): the install's active version, only while it
 * is enabled, not removed, and runs for its owner, plus the Thread's state
 * for a thread-scoped object. One D1 read, cached a few minutes per object.
 */

export interface DurableInstallState {
  readonly install: PluginInstallRecord;
  /** For a thread-scoped object: whether its Thread is archived or gone. */
  readonly thread?: { readonly archived: boolean; readonly deleted: boolean };
  /** `archivedThreads` setting; `hide` when absent. */
  readonly archivedThreads: "hide" | "show" | "live";
}

interface Row {
  readonly id: string;
  readonly scope: string;
  readonly target_id: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly manifest_json: string;
  readonly thread_state: string | null;
  readonly trusted_by_user_id: string | null;
  readonly tier_cap: string | null;
  readonly trusted_signature: number | null;
}

export const loadDurableInstall = async (
  db: D1Database,
  input: {
    readonly installId: string;
    readonly ownerUserId: string;
    readonly threadId?: string | undefined;
  },
): Promise<DurableInstallState | undefined> => {
  const row = await db
    .prepare(
      `SELECT plugin.id, plugin.scope, plugin.target_id, plugin.name,
              version.trusted_by_user_id,
              version.version, version.integrity, version.manifest_json,
              (SELECT lifecycle_state FROM threads WHERE id = ?3) AS thread_state,
              ${installTrustColumns("plugin")}
         FROM trusted_plugin plugin
         JOIN trusted_plugin_version version
           ON version.plugin_id = plugin.id
          AND version.version = plugin.active_version
        WHERE plugin.id = ?1
          AND plugin.kind = 'bundle'
          AND plugin.enabled = 1
          AND plugin.removed_at IS NULL
          AND ${pluginRunsForOwnerSql("plugin", "?2")}
          AND (plugin.scope = 'personal' OR ${activeMemberSql("plugin.target_id", "?2")})
        LIMIT 1`,
    )
    .bind(input.installId, input.ownerUserId, input.threadId ?? "")
    .first<Row>();
  if (row === null) return undefined;
  let manifest: { code?: unknown; displayName?: unknown; iconSet?: unknown };
  try {
    manifest = JSON.parse(row.manifest_json) as typeof manifest;
  } catch {
    return undefined;
  }
  const code = decodePluginCode(manifest.code);
  if (Option.isNone(code)) return undefined;
  // A live plugin, pane, or tab keeps the plugin's object running.
  const archived = durableArchivedMode(code.value);
  // The icon set, so a wake or note from a job carries the plugin's icon
  // as the Worker host's posts do.
  const iconSet = storedIconSet(manifest);
  return {
    install: {
      ...(iconSet === undefined ? {} : { iconSet }),
      pluginId: row.id,
      name: row.name,
      displayName:
        typeof manifest.displayName === "string"
          ? manifest.displayName
          : row.name,
      scope: row.scope === "workspace" ? "workspace" : "personal",
      targetId: row.target_id,
      version: row.version,
      integrity: row.integrity,
      code: code.value,
      tier: installedPluginTier(
        row.scope === "workspace" ? "workspace" : "personal",
        code.value.tier,
        installTrustFromRow(row),
      ),
      ...(row.trusted_by_user_id === null
        ? {}
        : { installedByUserId: row.trusted_by_user_id }),
    },
    ...(input.threadId === undefined
      ? {}
      : {
          thread: {
            archived: row.thread_state === "archived",
            deleted:
              row.thread_state === null || row.thread_state === "deleted",
          },
        }),
    archivedThreads:
      archived === "show" || archived === "live" ? archived : "hide",
  };
};
