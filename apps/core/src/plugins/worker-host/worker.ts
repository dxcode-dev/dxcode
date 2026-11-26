import {
  PluginBundleCode,
  type PluginCodeEvent,
  type PluginHostKind,
  type PluginIconRef,
  pluginRebuildMessage,
  removedPluginFeatures,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import type { PluginAgentDefinition } from "../agents/definition.js";
import type { PluginHostDependencies, PluginInstallRecord } from "./host.js";

/**
 * Running plugin code: the entry points every feature calls. The host, its
 * runtime modules, and QuickJS live in worker-calls.ts and load on the first
 * call, so the core Worker does not evaluate them at startup (Cloudflare
 * refuses a deploy whose startup exceeds its CPU limit; measure with
 * `node internal/perf/worker-startup.mjs`).
 */

const logger = getLogger(["dx", "plugins", "worker-host"]);

const calls = () => import("./worker-calls.js");
/** A draft plugin's code runs from its folder in the Thread's Orb. */
const drafts = () => import("../drafts/orb.js");

/** The compatibility date plugin workers run on. */
export const PLUGIN_WORKER_COMPATIBILITY_DATE = "2026-08-20";

/** Bump to restart every plugin worker when the runtime module changes. */
const RUNTIME_GENERATION = 11;

export const pluginWorkerId = (
  install: {
    readonly integrity: string;
    readonly scope: string;
    readonly targetId: string;
  },
  kind: PluginHostKind = "worker",
) =>
  `dxp${RUNTIME_GENERATION}:${install.integrity}:${install.scope}:${install.targetId}${kind === "worker" ? "" : `:${kind}`}`;

/** What `describe()` reports about the code. */
export interface PluginCodeDescription {
  readonly events: ReadonlyArray<PluginCodeEvent>;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    /** `lucide:<name>` or an icon hash. */
    readonly icon?: PluginIconRef;
  }>;
  readonly commands: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    /** `lucide:<name>` or an icon hash. */
    readonly icon?: PluginIconRef;
  }>;
  readonly linkPatterns: ReadonlyArray<{
    readonly pattern: string;
    readonly flags?: string;
    readonly url: string;
    readonly title?: string;
  }>;
  /** Exposed functions the manifest's `exports` lists. */
  readonly exports: ReadonlyArray<string>;
  /**
   * Agent modes the code registered that its manifest declares and its
   * grants allow, each agent checked as dx checks any plugin agent.
   */
  readonly agentModes: ReadonlyArray<{
    readonly key: string;
    readonly agent: PluginAgentDefinition;
  }>;
}

export class PluginHostUnavailable extends Error {
  override readonly name = "PluginHostUnavailable";
}

/**
 * Where this deployment runs plugin code: Dynamic Workers when it has the
 * loader; QuickJS only when its operator chose it with
 * `DX_PLUGIN_HOST=quickjs`, since QuickJS runs plugin code inside dx's own
 * isolate. Otherwise plugin code does not run, and a plugin that gates tool
 * calls rejects them (fail closed).
 */
export const pluginHostKind = (bindings: Bindings) =>
  bindings.LOADER !== undefined
    ? "dynamic-worker"
    : bindings.DX_PLUGIN_HOST === "quickjs"
      ? "quickjs"
      : "none";

/**
 * Starts (or reuses) the install's worker and asks what its code handles.
 * Events the manifest does not grant are dropped: dx never sends them.
 */
export const describePlugin = async (
  bindings: Bindings,
  db: D1Database,
  install: PluginInstallRecord,
): Promise<PluginCodeDescription> =>
  (await calls()).describePlugin(bindings, db, install);

/** Sends one event to the install's worker and returns its combined result. */
export const dispatchPluginEvent = async (
  dependencies: PluginHostDependencies,
  event: PluginCodeEvent,
  payload: unknown,
  /** The worker times each handler; this bounds a worker that never answers. */
  timeoutMs?: number,
): Promise<unknown> =>
  dependencies.install.draft !== undefined
    ? (await drafts()).invokeDraft(dependencies, {
        kind: "event",
        event,
        payload,
      })
    : (await calls()).dispatchPluginEvent(
        dependencies,
        event,
        payload,
        timeoutMs,
      );

/** Runs one of the install's registered tools. */
export const callPluginTool = async (
  dependencies: PluginHostDependencies,
  name: string,
  input: unknown,
): Promise<unknown> =>
  dependencies.install.draft !== undefined
    ? (await drafts()).invokeDraft(dependencies, { kind: "tool", name, input })
    : (await calls()).callPluginTool(dependencies, name, input);

/** Runs one of the install's palette commands. */
export const runPluginCommand = async (
  dependencies: PluginHostDependencies,
  id: string,
): Promise<unknown> =>
  dependencies.install.draft !== undefined
    ? (await drafts()).invokeDraft(dependencies, { kind: "command", id })
    : (await calls()).runPluginCommand(dependencies, id);

/** Runs a function the install's Worker code exposed, for another host. */
export const callPluginWorkerHost = async (
  dependencies: PluginHostDependencies,
  fn: string,
  args: unknown,
  from: string,
): Promise<unknown> =>
  dependencies.install.draft !== undefined
    ? (await drafts()).invokeDraft(dependencies, {
        kind: "host-call",
        fn,
        args,
        from: "worker",
      })
    : (await calls()).callPluginWorkerHost(dependencies, fn, args, from);

/**
 * Runs one of the install's exposed functions for another plugin's
 * `ctx.plugins.call`, within `ms` (what is left of the caller's own limit).
 */
export const callPluginExport = async (
  dependencies: PluginHostDependencies,
  fn: string,
  args: unknown,
  ms: number,
): Promise<unknown> =>
  dependencies.install.draft !== undefined
    ? (await drafts()).invokeDraft(dependencies, {
        kind: "export",
        fn,
        args,
        callerPlugin: dependencies.calledBy ?? "",
      })
    : (await calls()).callPluginExport(dependencies, fn, args, ms);

/** Rebuild warnings already logged in this isolate, by plugin. */
const rebuildLogged = new Set<string>();

/**
 * The manifest's code block, decoded again where it leaves D1: a stored
 * version's code, or none when it does not decode or uses a
 * feature dx removed (`pluginRebuildMessage`): such a plugin does not load
 * until it is rebuilt, and dx logs why once per isolate and plugin.
 */
export const decodePluginCode = (
  value: unknown,
  plugin?: { readonly id: string; readonly name: string },
): Option.Option<PluginBundleCode> => {
  const rebuild = pluginRebuildMessage(value);
  if (rebuild !== undefined) {
    if (plugin !== undefined && !rebuildLogged.has(plugin.id)) {
      rebuildLogged.add(plugin.id);
      logger.warn(`Plugin ${plugin.name} must be rebuilt: ${rebuild}`, {
        event: "plugin_needs_rebuild",
        pluginId: plugin.id,
        removed: removedPluginFeatures(value),
      });
    }
    return Option.none();
  }
  return Schema.decodeUnknownOption(PluginBundleCode)(value);
};

export const logPluginFailure = (
  install: PluginInstallRecord,
  what: string,
  error: unknown,
) =>
  logger.warn(`Plugin ${install.name} ${what} failed.`, {
    event: "plugin_code_failed",
    pluginId: install.pluginId,
    version: install.version,
    what,
    error: error instanceof Error ? error.message : String(error),
  });
