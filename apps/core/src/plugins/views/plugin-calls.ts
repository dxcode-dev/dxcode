import { getLogger } from "@logtape/logtape";
import { insertPluginAudit } from "../audit/audit.js";
import {
  callTier,
  type PluginHostDependencies,
  type PluginInstallRecord,
} from "../worker-host/host.js";
import {
  listOwnerCodePluginInstalls,
  listThreadCodePluginInstalls,
} from "../worker-host/resolve.js";
import { TOOL_TIMEOUT_MS } from "../worker-host/runtime.js";
import { callPluginExport } from "../worker-host/worker.js";
import { installTier, type PluginTier, tierAtLeast } from "./tier.js";

/**
 * Plugin-to-plugin calls (`ctx.plugins.call(plugin, fn, args)`). Every call
 * goes through dx and is checked in this order, refused with the first
 * reason that applies:
 *
 * 1. `not-permitted`: the caller's `permissions.plugins` lists the callee.
 * 2. `cycle`: the callee is not already in the chain, and the chain is
 *    shorter than {@link MAX_PLUGIN_CALL_DEPTH}.
 * 3. `not-installed`: the callee is installed and on for the call's owner.
 * 4. `not-exported`: the callee's manifest `exports` lists `fn`.
 * 5. `owner-only`: a member's click on a workspace plugin's command,
 *    quick action, or pane (`actorUserId`) never reaches the owner's
 *    personal plugin, which runs with the owner's own secrets and hosts.
 * 6. `lower-tier`: the caller's tier is at least the callee's.
 *
 * The callee runs in its own isolate with its own permissions, settings,
 * and secrets, as the same owner, in the same Thread. Its time is what is
 * left of the caller's own limit. Each call, allowed or refused, writes one
 * `plugin.call` audit row and one `plugin_call` log line.
 */

export const MAX_PLUGIN_CALL_DEPTH = 3;

export type PluginCallRefusedCode =
  | "not-permitted"
  | "not-installed"
  | "not-exported"
  | "lower-tier"
  | "owner-only"
  | "cycle";

export class PluginCallRefused extends Error {
  override readonly name = "PluginCallRefused";
  constructor(
    readonly code: PluginCallRefusedCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

const logger = getLogger(["dx", "plugins", "calls"]);

/** A call never starts with less than this left of the caller's limit. */
const MIN_CALL_MS = 1_000;

const peersOf = (
  dependencies: PluginHostDependencies,
): Promise<ReadonlyArray<PluginInstallRecord>> =>
  dependencies.peers !== undefined
    ? dependencies.peers()
    : dependencies.threadId !== undefined
      ? listThreadCodePluginInstalls(dependencies.db, dependencies.threadId)
      : listOwnerCodePluginInstalls(dependencies.db, dependencies.ownerUserId);

export const callPlugin = async (
  dependencies: PluginHostDependencies,
  plugin: string,
  fn: string,
  args: unknown,
  /** What is left of the calling handler's own limit, from its isolate. */
  budgetMs?: number,
): Promise<unknown> => {
  const started = Date.now();
  const caller = dependencies.install;
  const tier = callTier(dependencies);
  const chain = [...(dependencies.callChain ?? []), caller.name];
  let calleeTier: PluginTier | undefined;
  const record = async (
    outcome: "success" | "rejected" | "failed",
    detail: Record<string, unknown>,
  ) => {
    const ms = Date.now() - started;
    const properties = {
      event: "plugin_call",
      requestId: dependencies.requestId,
      installId: caller.pluginId,
      plugin: caller.name,
      callee: plugin,
      fn,
      host: "worker",
      tier,
      calleeTier,
      threadId: dependencies.threadId,
      depth: chain.length,
      outcome,
      ms,
      ...detail,
    };
    if (outcome === "success")
      logger.info(`Plugin ${caller.name} called ${plugin}.${fn}.`, properties);
    else
      logger.warn(
        `Plugin ${caller.name}'s call to ${plugin}.${fn} ${outcome === "rejected" ? "was refused" : "failed"}.`,
        properties,
      );
    await insertPluginAudit(dependencies.db, {
      ...(dependencies.actorUserId === undefined
        ? {}
        : { actorUserId: dependencies.actorUserId }),
      pluginId: caller.pluginId,
      pluginName: caller.name,
      pluginVersion: caller.version,
      scope: caller.scope,
      ownerUserId: dependencies.ownerUserId,
      ...(dependencies.threadId === undefined
        ? {}
        : { threadId: dependencies.threadId }),
      ...(dependencies.requestId === undefined
        ? {}
        : { requestId: dependencies.requestId }),
      action: "plugin.call",
      target: `${plugin}.${fn}`.slice(0, 256),
      outcome,
      detail: { tier, calleeTier, depth: chain.length, ms, ...detail },
    });
  };
  const refuse = async (
    code: PluginCallRefusedCode,
    message: string,
  ): Promise<never> => {
    // A refusal refuses even when its row cannot be written.
    await record("rejected", { code }).catch(() => undefined);
    throw new PluginCallRefused(code, message);
  };

  // A repository's plugin was never installed by the owner: it neither
  // calls nor is called.
  if (
    caller.scope === "repository" ||
    !(caller.code.permissions.plugins ?? []).includes(plugin as never)
  )
    return refuse(
      "not-permitted",
      `${caller.name} may not call ${plugin}: its manifest's permissions.plugins does not list it.`,
    );
  if (chain.includes(plugin) || chain.length >= MAX_PLUGIN_CALL_DEPTH)
    return refuse(
      "cycle",
      chain.includes(plugin)
        ? `${plugin} is already in this call chain (${chain.join(" → ")}).`
        : `A plugin call chain is at most ${MAX_PLUGIN_CALL_DEPTH} plugins deep (${chain.join(" → ")}).`,
    );
  const callee = (await peersOf(dependencies)).find(
    (install) => install.name === plugin && install.scope !== "repository",
  );
  if (callee === undefined)
    return refuse(
      "not-installed",
      `${plugin} is not installed, or is off, for this Thread's owner.`,
    );
  calleeTier = installTier(callee);
  // As for a personal install's own panes and commands: only its owner
  // drives it. A member's message to a workspace plugin is the member's
  // input, so it never reaches the owner's personal plugin through a call.
  if (
    callee.scope === "personal" &&
    dependencies.actorUserId !== undefined &&
    dependencies.actorUserId !== callee.targetId
  )
    return refuse(
      "owner-only",
      `${plugin} is ${callee.targetId === dependencies.ownerUserId ? "the owner's" : "another person's"} personal plugin; only its owner's own actions reach it.`,
    );
  if (!(callee.code.exports ?? []).some(({ name }) => name === fn))
    return refuse(
      "not-exported",
      `${plugin} does not export ${fn}; its manifest's exports lists ${(callee.code.exports ?? []).map(({ name }) => name).join(", ") || "nothing"}.`,
    );
  if (!tierAtLeast(tier, calleeTier))
    return refuse(
      "lower-tier",
      `${caller.name} runs at the ${tier} tier, lower than ${plugin}'s ${calleeTier}; a plugin may call only plugins at or below its own tier.`,
    );
  // The callee spends the caller's time: the lower of the host call's limit
  // and the calling handler's own, as its isolate measured it.
  const ms = Math.min(
    TOOL_TIMEOUT_MS,
    (dependencies.remainingMs?.() ?? TOOL_TIMEOUT_MS) - 250,
    (budgetMs ?? TOOL_TIMEOUT_MS) - 250,
  );
  if (ms < MIN_CALL_MS) {
    await record("failed", { reason: "no-time" }).catch(() => undefined);
    throw new Error(
      `${caller.name} has too little of its time limit left to call ${plugin}.${fn}.`,
    );
  }
  // Written before the callee runs, so no call goes unaudited; a call whose
  // row cannot be written does not run.
  await record("success", {});
  try {
    const result = await callPluginExport(
      {
        db: dependencies.db,
        bindings: dependencies.bindings,
        install: callee,
        ...(dependencies.threadId === undefined
          ? {}
          : { threadId: dependencies.threadId }),
        ownerUserId: dependencies.ownerUserId,
        // The member who clicked stays the actor through the callee.
        ...(dependencies.actorUserId === undefined
          ? {}
          : { actorUserId: dependencies.actorUserId }),
        ...(dependencies.requestId === undefined
          ? {}
          : { requestId: dependencies.requestId }),
        ...(dependencies.turnStartedByPlugin === true
          ? { turnStartedByPlugin: true }
          : {}),
        callChain: chain,
        calledBy: caller.name,
        ...(dependencies.waitUntil === undefined
          ? {}
          : { waitUntil: dependencies.waitUntil }),
        ...(dependencies.peers === undefined
          ? {}
          : { peers: dependencies.peers }),
      },
      fn,
      args,
      ms,
    );
    return result ?? null;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 300) : "unknown";
    await record("failed", { reason }).catch(() => undefined);
    throw new Error(`${plugin}.${fn} failed: ${reason}`);
  }
};
