import { pluginHostEntry, TRUSTED_TIER, tierAtLeast } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import type { Bindings } from "../../../http/types.js";
import { configuredTierLimits } from "../../trust/limits.js";
import {
  type PluginCallInfo,
  PluginHost,
  type PluginInstallRecord,
  pluginCallInfo,
} from "../../worker-host/host.js";
import { linkApiImports } from "../../worker-host/runtime.js";
import { registerPluginHost } from "../registry.js";
import type { PluginTier } from "../tier.js";
import { PluginHostError } from "../types.js";
import {
  PLUGIN_CONTAINER_APT,
  PLUGIN_CONTAINER_CAPS,
  type PluginContainerCaps,
  pluginContainerCostMicroUsd,
} from "./limits.js";
import type {
  PluginContainerBilling,
  PluginContainerBinary,
  PluginContainerOutcome,
  PluginContainerResult,
} from "./object.js";

/**
 * Core's side of the `container` plugin host: checks the tier and the
 * manifest, calls the install's {@link PluginContainerObject} with the same
 * `PluginHost` capability object the Worker host gets, logs one structured
 * line per call, and writes the call's container time to
 * `plugin_host_usage`, charged to the installer's workspace.
 *
 * A container runs where no Thread or Orb exists, such as a webhook
 * delivery: nothing here needs a Thread.
 */

const logger = getLogger(["dx", "plugins", "hosts", "container"]);

/** What the shared host interface hands the container host for one call. */
export interface PluginContainerCall {
  readonly requestId: string;
  readonly bindings: Bindings;
  readonly db: D1Database;
  readonly install: PluginInstallRecord;
  readonly tier: PluginTier;
  readonly ownerUserId: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
  /** The capability object for this call; the container's ctx calls it. */
  readonly host: PluginHost;
  readonly info: PluginCallInfo;
  readonly invocation: {
    readonly kind: string;
    readonly fn?: string;
    readonly args?: unknown;
  };
  /** Overrides of the default caps, such as a workspace's own. */
  readonly caps?: Partial<PluginContainerCaps>;
}

/** Why a container call did not run, or how it ended. */
export type PluginContainerCallOutcome =
  | PluginContainerOutcome
  | "blocked-tier"
  | "not-declared"
  | "not-deployed";

export class PluginContainerError extends Error {
  readonly outcome: PluginContainerCallOutcome;
  constructor(outcome: PluginContainerCallOutcome, message: string) {
    super(message);
    this.name = "PluginContainerError";
    this.outcome = outcome;
  }
}

/** The manifest's container module, from the host object form. */
export const containerEntryOf = (install: PluginInstallRecord) =>
  pluginHostEntry(install.code, "container");

/** The manifest's `binaries`, shared with the Orb host. */
const binariesOf = (
  install: PluginInstallRecord,
): ReadonlyArray<PluginContainerBinary> =>
  (install.code as { readonly binaries?: ReadonlyArray<PluginContainerBinary> })
    .binaries ?? [];

/**
 * Whether this install's calls may reach a container: a trusted tier whose
 * limits list the host, a declared container module, and a deployment that
 * binds the namespace. The reason is what a blocked call logs.
 */
export const pluginContainerAccess = (
  bindings: Bindings,
  install: PluginInstallRecord,
  tier: PluginTier,
):
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly outcome: "blocked-tier" | "not-declared" | "not-deployed";
      readonly reason: string;
    } => {
  if (
    !tierAtLeast(tier, TRUSTED_TIER) ||
    !configuredTierLimits(bindings, tier).hosts.includes("container")
  )
    return {
      allowed: false,
      outcome: "blocked-tier",
      reason: `${install.displayName} runs at the ${tier} tier; containers need workspace trust.`,
    };
  if (containerEntryOf(install) === undefined)
    return {
      allowed: false,
      outcome: "not-declared",
      reason: `${install.displayName} declares no container module (host.container).`,
    };
  if (bindings.PLUGIN_CONTAINER === undefined)
    return {
      allowed: false,
      outcome: "not-deployed",
      reason: "This deployment runs no plugin containers.",
    };
  return { allowed: true };
};

/** The install's modules, linked as the Worker host links them. */
const loadContainerCode = async (
  db: D1Database,
  install: PluginInstallRecord,
): Promise<Record<string, string>> => {
  const { apiModuleSource } = await import("../../worker-host/runtime.js");
  const rows = await (install.scope === "repository"
    ? db
        .prepare(
          "SELECT path, content, integrity FROM repository_plugin_file WHERE bundle_integrity = ?",
        )
        .bind(install.integrity)
    : db
        .prepare(
          "SELECT path, content, integrity FROM trusted_plugin_file WHERE plugin_id = ? AND version = ?",
        )
        .bind(install.pluginId, install.version)
  ).all<{ path: string; content: string; integrity: string }>();
  const byPath = new Map(rows.results.map((row) => [row.path, row]));
  const files: Record<string, string> = {
    "dxcode-plugin-api.js": apiModuleSource,
  };
  for (const declared of install.code.modules) {
    const row = byPath.get(declared.path);
    if (row === undefined || row.integrity !== declared.integrity)
      throw new Error(
        `${install.name}'s stored code does not match its reviewed version (${declared.path}).`,
      );
    files[declared.path] = linkApiImports(row.path, row.content);
  }
  return files;
};

/**
 * The workspace a personal install's container time is billed to, and
 * counted against: the workspace of the Thread's Project, else the owner's
 * workspace (one per person: member.userId is unique), else none. One
 * indexed read, only for a personal install, kept for a minute per Thread
 * and owner in this isolate.
 */
const payers = new Map<string, { workspaceId: string | null; at: number }>();
const payerWorkspace = async (call: PluginContainerCall) => {
  if (call.workspaceId !== undefined) return call.workspaceId;
  if (call.install.scope === "workspace") return call.install.targetId;
  const key = `${call.threadId ?? ""}|${call.ownerUserId}`;
  const cached = payers.get(key);
  if (cached !== undefined && Date.now() - cached.at < 60_000)
    return cached.workspaceId ?? undefined;
  const row = await call.db
    .prepare(
      `SELECT COALESCE(
         (SELECT project.workspace_id FROM threads thread
            JOIN projects project ON project.id = thread.project_id
           WHERE thread.id = ?1),
         (SELECT member.organizationId FROM member
           WHERE member.userId = ?2
           ORDER BY member.createdAt, member.organizationId LIMIT 1)
       ) AS workspace_id`,
    )
    .bind(call.threadId ?? null, call.ownerUserId)
    .first<{ workspace_id: string | null }>()
    .catch(() => undefined);
  // A failed read is not "no workspace": not cached, and the flush's own
  // INSERT still resolves the payer.
  if (row === undefined) return undefined;
  const workspaceId = row?.workspace_id ?? null;
  if (payers.size > 1_000) payers.clear();
  payers.set(key, { workspaceId, at: Date.now() });
  return workspaceId ?? undefined;
};

/** Who pays: the installer's workspace, or the payer workspace above. */
const billingOf = async (
  call: PluginContainerCall,
): Promise<PluginContainerBilling> => {
  const workspaceId = await payerWorkspace(call);
  return {
    pluginId: call.install.pluginId,
    pluginName: call.install.name,
    scope: call.install.scope,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(call.threadId === undefined ? {} : { threadId: call.threadId }),
    ownerUserId: call.ownerUserId,
  };
};

const logCall = (
  call: PluginContainerCall,
  outcome: PluginContainerCallOutcome,
  started: number,
  extra: Record<string, unknown> = {},
) => {
  const properties = {
    event: "plugin_container_call",
    requestId: call.requestId,
    installId: call.install.pluginId,
    plugin: call.install.name,
    host: "container",
    tier: call.tier,
    fn: call.invocation.fn,
    outcome,
    ms: Date.now() - started,
    ...extra,
  };
  if (outcome === "success")
    logger.info("Plugin container call finished.", properties);
  else logger.warn("Plugin container call did not succeed.", properties);
};

/**
 * Runs one call in the install's container and returns its value; a call
 * that is blocked or fails throws {@link PluginContainerError}.
 */
export const invokePluginContainer = async (
  call: PluginContainerCall,
): Promise<unknown> => {
  const started = Date.now();
  const access = pluginContainerAccess(call.bindings, call.install, call.tier);
  if (!access.allowed) {
    logCall(call, access.outcome, started, { reason: access.reason });
    // Counted with the install's usage in its container object (no D1
    // write here); the object flushes it with the rest.
    if (
      access.outcome === "blocked-tier" &&
      call.bindings.PLUGIN_CONTAINER !== undefined
    ) {
      const namespace = call.bindings.PLUGIN_CONTAINER;
      await namespace
        .get(namespace.idFromName(call.install.pluginId))
        .recordBlocked(await billingOf(call))
        .catch(() => undefined);
    }
    throw new PluginContainerError(access.outcome, access.reason);
  }
  const binaries = binariesOf(call.install);
  const missing = binaries.find(
    (binary) =>
      binary.url === undefined &&
      binary.apt !== undefined &&
      !PLUGIN_CONTAINER_APT.has(binary.apt),
  );
  if (missing !== undefined) {
    const reason = `The plugin container image has no ${missing.apt}; declare it with a url and sha256.`;
    logCall(call, "unavailable", started, { reason });
    throw new PluginContainerError("unavailable", reason);
  }
  const dailyOverride = Number(call.bindings.DX_PLUGIN_CONTAINER_DAILY_MS);
  const workspaceOverride = Number(
    call.bindings.DX_PLUGIN_CONTAINER_WORKSPACE_DAILY_MS,
  );
  const limits = configuredTierLimits(call.bindings, call.tier);
  const caps: PluginContainerCaps = {
    ...PLUGIN_CONTAINER_CAPS,
    // The tier's call time and binary size (plugin-trust.ts), as configured.
    callMs: limits.callMs,
    binaryBytes: Math.min(
      PLUGIN_CONTAINER_CAPS.binaryBytes,
      limits.binaryAssetBytes,
    ),
    // Only ever lower: a deployment can tighten the cap, never lift it.
    ...(Number.isInteger(dailyOverride) && dailyOverride > 0
      ? { dailyMs: Math.min(dailyOverride, PLUGIN_CONTAINER_CAPS.dailyMs) }
      : {}),
    ...(Number.isInteger(workspaceOverride) && workspaceOverride > 0
      ? {
          workspaceDailyMs: Math.min(
            workspaceOverride,
            PLUGIN_CONTAINER_CAPS.workspaceDailyMs,
          ),
        }
      : {}),
    ...call.caps,
  };
  const namespace = call.bindings.PLUGIN_CONTAINER;
  if (namespace === undefined)
    throw new PluginContainerError(
      "not-deployed",
      "This deployment runs no plugin containers.",
    );
  const stub = namespace.get(namespace.idFromName(call.install.pluginId));
  const entry = containerEntryOf(call.install) ?? "";
  let result: PluginContainerResult;
  try {
    result = (await stub.invoke(
      {
        requestId: call.requestId,
        installId: call.install.pluginId,
        integrity: call.install.integrity,
        entry,
        call: call.invocation,
        info: { ...call.info, tier: call.tier },
        binaries,
        caps,
        billing: await billingOf(call),
      },
      call.host as never,
      // Read only when the container lacks this version's code.
      () => loadContainerCode(call.db, call.install),
    )) as PluginContainerResult;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logCall(call, "unavailable", started, { reason });
    throw new PluginContainerError("unavailable", reason);
  }
  const costMicroUsd = pluginContainerCostMicroUsd(result.billedMs);
  logCall(call, result.outcome, started, {
    cold: result.cold,
    ...(result.startMs === undefined ? {} : { startMs: result.startMs }),
    billedMs: result.billedMs,
    costMicroUsd,
    usedTodayMs: result.usedTodayMs,
    ranTodayMs: result.ranTodayMs,
    ranMonthMs: result.ranMonthMs,
    ...(result.runMs === undefined ? {} : { runMs: result.runMs }),
    usedMonthMs: result.usedMonthMs,
    ...(result.error === undefined ? {} : { reason: result.error }),
  });
  if (result.outcome !== "success")
    throw new PluginContainerError(
      result.outcome,
      result.error ?? "The container call failed.",
    );
  return result.value ?? null;
};

/** The install's container state, for the host interface's `status`. */
export const pluginContainerStatus = async (
  bindings: Bindings,
  installId: string,
) => {
  const namespace = bindings.PLUGIN_CONTAINER;
  if (namespace === undefined) return { state: "stopped" as const, since: 0 };
  return namespace.get(namespace.idFromName(installId)).status();
};

/** Stops the install's container, for the host interface's `stop`. */
export const stopPluginContainer = async (
  bindings: Bindings,
  installId: string,
  reason: "archived" | "uninstalled" | "idle" | "limit",
) => {
  const namespace = bindings.PLUGIN_CONTAINER;
  if (namespace === undefined) return;
  await namespace.get(namespace.idFromName(installId)).stop(reason);
  logger.info("Plugin container stop requested.", {
    event: "plugin_container_stop",
    installId,
    reason,
  });
};

const hostErrorOf = (error: unknown) => {
  const outcome =
    error instanceof PluginContainerError ? error.outcome : "unavailable";
  return new PluginHostError({
    host: "container",
    reason:
      outcome === "blocked-tier" || outcome === "not-declared"
        ? outcome
        : outcome === "over-cap"
          ? "quota"
          : outcome === "not-deployed" || outcome === "unavailable"
            ? "unavailable"
            : "failed",
    message: error instanceof Error ? error.message : String(error),
  });
};

/**
 * The container host behind the shared interface: one container per
 * install, started on demand. Each call gets its own `PluginHost` built from
 * the same dependencies the Worker host's would be, and closed when the
 * call ends.
 */
registerPluginHost("container", ({ dependencies }) => ({
  kind: "container",
  invoke: (target, invocation) =>
    Effect.tryPromise({
      try: async () => {
        const capabilities = {
          ...dependencies,
          tier: target.tier,
          currentHost: "container" as const,
        };
        const host = new PluginHost(capabilities);
        try {
          return await invokePluginContainer({
            requestId: dependencies.requestId ?? crypto.randomUUID(),
            bindings: dependencies.bindings,
            db: dependencies.db,
            install: dependencies.install,
            tier: target.tier,
            ownerUserId: dependencies.ownerUserId,
            ...(target.threadId === undefined
              ? {}
              : { threadId: target.threadId }),
            ...(target.workspaceId === ""
              ? {}
              : { workspaceId: target.workspaceId }),
            host,
            info: pluginCallInfo(capabilities),
            invocation:
              invocation.kind === "host-call" || invocation.kind === "export"
                ? {
                    kind: invocation.kind,
                    fn: invocation.fn,
                    args: invocation.args,
                  }
                : { kind: invocation.kind },
          });
        } finally {
          host.close();
        }
      },
      catch: hostErrorOf,
    }),
  status: (target) =>
    Effect.promise(() =>
      pluginContainerStatus(dependencies.bindings, target.installId),
    ),
  stop: (target, reason) =>
    Effect.promise(() =>
      stopPluginContainer(dependencies.bindings, target.installId, reason),
    ),
}));
