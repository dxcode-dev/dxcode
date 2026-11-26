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
} from "../worker-host/worker.js";
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

/** Why a host refuses a call, before it reaches any code. */
export const pluginHostRefusal = (
  code: PluginHostDependencies["install"]["code"],
  kind: PluginHostKind,
): PluginHostError | undefined =>
  pluginHostEntry(code, kind) === undefined
    ? new PluginHostError({
        host: kind,
        reason: "not-declared",
        message: `This plugin has no ${kind} code: its manifest's host names no ${kind} entry.`,
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
  readonly call: PluginInvocation["kind"];
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
        }
      },
      catch: failed,
    }),
  // Dynamic Workers start on demand and are evicted by the runtime.
  status: () => Effect.succeed({ state: "running" as const, since: 0 }),
  stop: () => Effect.void,
}));
