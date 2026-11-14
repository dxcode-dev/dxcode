import type { PluginHostKind } from "@dx/domain";
import { pluginHostEntry } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import type { PluginHostDependencies } from "../worker-host/host.js";
import {
  callPluginTool,
  callPluginWorkerHost,
  dispatchPluginEvent,
  runPluginCommand,
  sendPaneMessage,
} from "../worker-host/worker.js";
import { tierAllowsHost } from "./policy.js";
import type { PluginTier } from "./tier.js";
import {
  PluginHostError,
  type PluginHostRuntime,
  type PluginHostTarget,
  type PluginInvocation,
} from "./types.js";

/**
 * One factory per host kind. The Worker host is registered here and wraps
 * today's worker host; the other hosts register themselves from their own
 * folders with {@link registerPluginHost} (imported by `hosts/index.ts`), so
 * adding a host never edits this file.
 */

const logger = getLogger(["dx", "plugins", "hosts"]);

/** What a host needs to run one install's code for one call. */
export interface PluginHostContext {
  /** The capability object's inputs: the same for every host. */
  readonly dependencies: PluginHostDependencies;
}

export type PluginHostFactory = (
  context: PluginHostContext,
) => PluginHostRuntime;

const factories = new Map<PluginHostKind, PluginHostFactory>();

export const registerPluginHost = (
  kind: PluginHostKind,
  factory: PluginHostFactory,
) => {
  factories.set(kind, factory);
};

export const pluginHostRuntime = (
  kind: PluginHostKind,
  context: PluginHostContext,
): PluginHostRuntime | undefined => factories.get(kind)?.(context);

export { tierAllowsHost };

/**
 * The hosts one call may reach with `ctx.host(kind)`: declared in the
 * manifest, allowed by the tier, and registered in this deployment.
 */
export const reachablePluginHosts = (
  code: PluginHostDependencies["install"]["code"],
  tier: PluginTier,
): ReadonlyArray<PluginHostKind> =>
  (["worker", "durable", "orb", "container"] as const).filter(
    (kind) =>
      pluginHostEntry(code, kind) !== undefined &&
      tierAllowsHost(tier, kind) &&
      factories.has(kind),
  );

/** Why a host refuses a call, before it reaches any code. */
export const pluginHostRefusal = (
  code: PluginHostDependencies["install"]["code"],
  tier: PluginTier,
  kind: PluginHostKind,
): PluginHostError | undefined =>
  pluginHostEntry(code, kind) === undefined
    ? new PluginHostError({
        host: kind,
        reason: "not-declared",
        message: `This plugin has no ${kind} code: its manifest's host names no ${kind} entry.`,
      })
    : !tierAllowsHost(tier, kind)
      ? new PluginHostError({
          host: kind,
          reason: "blocked-tier",
          message: `The ${kind} host needs a trusted tier; this install runs as ${tier}.`,
        })
      : !factories.has(kind)
        ? new PluginHostError({
            host: kind,
            reason: "unavailable",
            message: `This deployment does not run the ${kind} host.`,
          })
        : undefined;

/** One structured line per host call, so proof ties log lines to requests. */
export const logPluginHostCall = (fields: {
  readonly requestId?: string | undefined;
  readonly installId: string;
  readonly host: PluginHostKind | "unknown";
  /** The host the call came from, for host-to-host calls. */
  readonly from?: PluginHostKind | undefined;
  readonly tier: PluginTier;
  readonly call: PluginInvocation["kind"] | "watch";
  readonly outcome: string;
  readonly ms: number;
  readonly threadId?: string | undefined;
  readonly detail?: string | undefined;
}) =>
  logger[fields.outcome === "ok" ? "info" : "warn"](
    `Plugin host call ${fields.host} ${fields.call}: ${fields.outcome}.`,
    { event: "plugin_host_call", ...fields },
  );

const failed = (error: unknown) =>
  new PluginHostError({
    host: "worker",
    reason: "failed",
    message: error instanceof Error ? error.message : String(error),
  });

/** The Worker host: today's Dynamic Worker host behind the shared interface. */
registerPluginHost("worker", ({ dependencies }) => ({
  kind: "worker",
  invoke: (_target: PluginHostTarget, call: PluginInvocation) =>
    Effect.tryPromise({
      try: (): Promise<unknown> => {
        switch (call.kind) {
          case "event":
            return dispatchPluginEvent(dependencies, call.event, call.payload);
          case "tool":
            return callPluginTool(dependencies, call.name, call.input);
          case "command":
            return runPluginCommand(dependencies, call.id);
          case "pane-message":
            return sendPaneMessage(dependencies, call.paneId, call.message);
          case "host-call":
            return callPluginWorkerHost(
              dependencies,
              call.fn,
              call.args,
              call.from,
            );
          case "export":
            return callPluginWorkerHost(
              dependencies,
              call.fn,
              call.args,
              "worker",
            );
          case "job":
            return Promise.reject(
              new Error("Jobs run in the durable host, not the Worker host."),
            );
        }
      },
      catch: failed,
    }),
  // Dynamic Workers start on demand and are evicted by the runtime.
  status: () => Effect.succeed({ state: "running" as const, since: 0 }),
  stop: () => Effect.void,
}));
