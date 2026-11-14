import type { TriggerPluginCapabilityData } from "@dx/api";
import { pluginHostEntry } from "@dx/domain";
import { Context, Effect, Layer, Option } from "effect";
import type { Bindings } from "../../http/types.js";
import { pluginRunsForOwnerSql } from "../../settings/plugins/bundles/overlap.js";
import { storedIconSet } from "../icons/store.js";
import { configuredTierLimits } from "../trust/limits.js";
import {
  installedPluginTier,
  installTrustColumns,
  installTrustFromRow,
} from "../trust/resolve-tier.js";
import type { PluginInstallRecord } from "./host.js";
import { triggerLeaseMs } from "./trigger-lease.js";
import { decodePluginCode, dispatchPluginEvent } from "./worker.js";

/**
 * Webhook triggers for plugins with code. A person creates a trigger for an
 * installed plugin whose code handles `trigger.received` (Settings →
 * Triggers); its capability URL takes deliveries into the trigger's durable
 * delivery object, which sends each one to the install's Dynamic Worker as
 * a `trigger.received` event. No Thread exists yet: the handler gets no
 * `ctx.thread`, and may start Threads with `ctx.threads.create` when the
 * manifest grants `permissions.threads`. The trigger runs as its owner.
 */

/** The trigger capability a plugin with code offers. */
export const CODE_TRIGGER_CAPABILITY = "webhook";
export const CODE_TRIGGER_EVENT = "trigger.received";

interface InstallRow {
  readonly id: string;
  readonly scope: string;
  readonly target_id: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly manifest_json: string;
  readonly tier_cap: string | null;
  readonly trusted_signature: number | null;
  readonly source_json: string;
}

const installOf = (row: InstallRow): PluginInstallRecord | undefined => {
  let manifest: { code?: unknown; displayName?: unknown; iconSet?: unknown };
  try {
    manifest = JSON.parse(row.manifest_json) as typeof manifest;
  } catch {
    return undefined;
  }
  const code = decodePluginCode(manifest.code);
  if (
    Option.isNone(code) ||
    !code.value.permissions.events.includes(CODE_TRIGGER_EVENT)
  )
    return undefined;
  const scope = row.scope === "workspace" ? "workspace" : "personal";
  return {
    pluginId: row.id,
    name: row.name,
    displayName:
      typeof manifest.displayName === "string"
        ? manifest.displayName
        : row.name,
    scope,
    targetId: row.target_id,
    version: row.version,
    integrity: row.integrity,
    code: code.value,
    tier: installedPluginTier(scope, code.value.tier, installTrustFromRow(row)),
    ...(storedIconSet(manifest) === undefined
      ? {}
      : { iconSet: storedIconSet(manifest) }),
  };
};

const installSelect = `
  SELECT plugin.id, plugin.scope, plugin.target_id, plugin.name,
         version.version, version.integrity, version.manifest_json,
         version.source_json,
         ${installTrustColumns("plugin")}
    FROM trusted_plugin plugin
    JOIN trusted_plugin_version version
      ON version.plugin_id = plugin.id
     AND version.version = plugin.active_version
   WHERE plugin.kind = 'bundle'
     AND plugin.enabled = 1
     AND plugin.removed_at IS NULL
     AND json_type(version.manifest_json, '$.code') = 'object'`;

/**
 * An install that runs for the owner, by the overlap rule Threads use
 * (bundles/overlap.ts). Delivery and the capability list share it.
 */
const reachable = (owner: string) => pluginRunsForOwnerSql("plugin", owner);

/** The install a code plugin's trigger delivers to: its active version. */
export const findCodePluginTriggerInstall = async (
  db: D1Database,
  pluginId: string,
  ownerUserId: string,
) => {
  const row = await db
    .prepare(
      `${installSelect} AND plugin.id = ?2 AND ${reachable("?1")} LIMIT 1`,
    )
    .bind(ownerUserId, pluginId)
    .first<InstallRow>();
  return row === null ? undefined : installOf(row);
};

/**
 * Code plugins the owner may create a webhook trigger for: their personal
 * installs and their workspaces' installs whose code handles
 * `trigger.received`. A personal copy of a plugin a workspace also installs
 * is left out, as in Thread resolution.
 */
export const listCodePluginTriggerCapabilities = async (
  db: D1Database,
  ownerUserId: string,
): Promise<ReadonlyArray<TriggerPluginCapabilityData>> => {
  const rows = await db
    .prepare(
      `${installSelect}
         AND ${reachable("?1")}
       ORDER BY CASE plugin.scope WHEN 'workspace' THEN 0 ELSE 1 END,
                plugin.name, plugin.id`,
    )
    .bind(ownerUserId)
    .all<InstallRow>();
  const capabilities: Array<TriggerPluginCapabilityData> = [];
  for (const row of rows.results) {
    const install = installOf(row);
    if (install === undefined) continue;
    let label = "Plugin";
    try {
      const source = JSON.parse(row.source_json) as {
        type?: string;
        label?: string;
        repository?: string;
      };
      label =
        source.type === "github"
          ? `GitHub: ${source.repository ?? ""}`
          : (source.label ?? label);
    } catch {}
    capabilities.push({
      pluginId: install.pluginId,
      pluginName: install.name,
      pluginDisplayName: install.displayName,
      version: install.version,
      source: "webhook",
      sourceLabel: label,
      capabilityName: CODE_TRIGGER_CAPABILITY,
      description: `Sends each webhook delivery to ${install.displayName}'s code as a trigger.received event.`,
      event: CODE_TRIGGER_EVENT,
      action: CODE_TRIGGER_CAPABILITY,
      permission: "trigger-delivery",
      idempotent: false,
    } as unknown as TriggerPluginCapabilityData);
  }
  return capabilities;
};

/**
 * How long a delivery's lease lasts: 30 seconds, or for an install whose
 * code hands work to its container host, the container call's limit plus a
 * cold start, so a transcode started by a webhook is not cut off.
 */
export const codePluginTriggerLeaseMs = (
  bindings: Pick<Bindings, "DX_PLUGIN_TIER_LIMITS">,
  install: PluginInstallRecord,
  defaultMs: number,
) =>
  triggerLeaseMs({
    container: pluginHostEntry(install.code, "container") !== undefined,
    callMs: configuredTierLimits(bindings, install.tier ?? "sandboxed").callMs,
    defaultMs,
  });

/** Sends one delivery to the install's worker as `trigger.received`. */
export const deliverCodePluginTrigger = (
  bindings: Bindings,
  db: D1Database,
  input: {
    readonly install: PluginInstallRecord;
    readonly ownerUserId: string;
    readonly triggerId: string;
    readonly deliveryId: string;
    readonly eventId: string;
    readonly idempotencyKey: string;
    readonly attempt: number;
    readonly payload: unknown;
  },
) =>
  dispatchPluginEvent(
    {
      db,
      bindings,
      install: input.install,
      ownerUserId: input.ownerUserId,
      // ─── Container host ───
      // The install's tier rides on its record (installedPluginTier); the
      // installer's workspace pays for its hosts, and the delivery ID ties
      // its log lines together.
      requestId: input.deliveryId,
      deliveryId: input.deliveryId,
      ...(input.install.scope === "workspace"
        ? { workspaceId: input.install.targetId }
        : {}),
    },
    CODE_TRIGGER_EVENT,
    {
      trigger: { id: input.triggerId },
      data: input.payload,
      eventId: input.eventId,
      deliveryId: input.deliveryId,
      idempotencyKey: input.idempotencyKey,
      attempt: input.attempt,
    },
    // Inside the delivery's lease, so a delivery never outlives it.
    codePluginTriggerLeaseMs(bindings, input.install, 30_000) - 5_000,
  );

/** Where the trigger service finds code plugins' webhook capabilities. */
export class CodePluginTriggerCapabilities extends Context.Service<
  CodePluginTriggerCapabilities,
  {
    readonly list: (
      ownerUserId: string,
    ) => Effect.Effect<ReadonlyArray<TriggerPluginCapabilityData>, unknown>;
  }
>()("@dx/core/plugins/worker-host/CodePluginTriggerCapabilities") {
  static readonly layer = (db: D1Database) =>
    Layer.succeed(
      CodePluginTriggerCapabilities,
      CodePluginTriggerCapabilities.of({
        list: (ownerUserId) =>
          Effect.tryPromise(() =>
            listCodePluginTriggerCapabilities(db, ownerUserId),
          ),
      }),
    );
}
