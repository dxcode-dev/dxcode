import { getLogger } from "@logtape/logtape";
import { recordPluginHostUsage } from "../usage.js";
import type { DurableMeta } from "./client.js";

/**
 * What the durable host costs, billed to the installer's workspace (D4):
 * Durable Object duration (128 MB, while code runs or a watch is open),
 * requests, and stored bytes (SQLite and R2). Each object adds its usage up
 * and writes one `plugin_host_usage` row about every 15
 * minutes, never one per call.
 */

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

/** Workers Paid list prices, in micro-dollars. */
const DURATION_MICRO_USD_PER_MS = (12.5 * 0.125) / 1_000; // $12.50 per million GB-s at 128 MB
const REQUEST_MICRO_USD = 0.15; // $0.15 per million requests
const STORAGE_MICRO_USD_PER_BYTE_MONTH = 0.2 / 1_000; // $0.20 per GB-month (SQLite; R2 is cheaper)
const MONTH_MS = 30 * 24 * 60 * 60 * 1_000;

export const durableCostMicroUsd = (usage: {
  readonly activeMs: number;
  readonly requests: number;
  readonly storageBytes: number;
  readonly periodMs: number;
}) =>
  Math.round(
    usage.activeMs * DURATION_MICRO_USD_PER_MS +
      usage.requests * REQUEST_MICRO_USD +
      usage.storageBytes *
        STORAGE_MICRO_USD_PER_BYTE_MONTH *
        (Math.max(0, usage.periodMs) / MONTH_MS),
  );

export const recordDurableUsage = async (
  db: D1Database,
  usage: {
    readonly meta: DurableMeta;
    readonly unitsMs: number;
    readonly requests: number;
    readonly storageBytes: number;
    readonly costMicroUsd: number;
    readonly periodStart: number;
    readonly periodEnd: number;
  },
) => {
  const { meta } = usage;
  logger.info(`Plugin ${meta.pluginName} durable host usage.`, {
    event: "plugin_host_usage",
    installId: meta.installId,
    host: "durable",
    tier: meta.tier,
    threadId: meta.threadId,
    workspaceId: meta.workspaceId,
    unitsMs: usage.unitsMs,
    requests: usage.requests,
    storageBytes: usage.storageBytes,
    costMicroUsd: usage.costMicroUsd,
  });
  // The host usage table: one row per object every 15 minutes, billed to the
  // workspace (resolved from the owner's membership when the install is
  // personal). `instance` names a container type, so a Durable Object
  // leaves it empty.
  await recordPluginHostUsage(db, {
    pluginId: meta.installId,
    pluginName: meta.pluginName,
    scope: meta.scope,
    ...(meta.workspaceId === "" ? {} : { workspaceId: meta.workspaceId }),
    ownerUserId: meta.ownerUserId,
    ...(meta.threadId === undefined ? {} : { threadId: meta.threadId }),
    host: "durable",
    unitsMs: usage.unitsMs,
    requests: usage.requests,
    storageBytes: usage.storageBytes,
    costMicroUsd: usage.costMicroUsd,
    outcome: "success",
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
  });
};
