import {
  type PluginArchivedMode,
  PluginBundleCode,
  type PluginCodeEvent,
  type PluginHostKind,
  type PluginIconRef,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Schema } from "effect";
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
  readonly panes: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly html: string;
    readonly handlesMessages: boolean;
    /** The manifest's icon for the pane, else the one it registered. */
    readonly icon?: PluginIconRef;
    /** The manifest's `archivedThreads` for the pane, when it sets one. */
    readonly archivedThreads?: PluginArchivedMode;
  }>;
  /**
   * Views its code registered that the manifest's `views` declares,
   * by id; tabs and pages look them up here.
   */
  readonly views: ReadonlyArray<{
    readonly id: string;
    readonly html: string;
    readonly handlesMessages: boolean;
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
  (await calls()).dispatchPluginEvent(dependencies, event, payload, timeoutMs);

/** Runs one of the install's registered tools. */
export const callPluginTool = async (
  dependencies: PluginHostDependencies,
  name: string,
  input: unknown,
): Promise<unknown> =>
  (await calls()).callPluginTool(dependencies, name, input);

/** Runs one of the install's palette commands. */
export const runPluginCommand = async (
  dependencies: PluginHostDependencies,
  id: string,
): Promise<unknown> => (await calls()).runPluginCommand(dependencies, id);

/**
 * Runs one of the install's panes' `onMessage` for a message its view sent
 * with `dx/plugin.post`, and returns its result.
 */
export const sendPaneMessage = async (
  dependencies: PluginHostDependencies,
  id: string,
  message: unknown,
): Promise<unknown> =>
  (await calls()).sendPaneMessage(dependencies, id, message);

/** Runs a function the install's Worker code exposed, for another host. */
export const callPluginWorkerHost = async (
  dependencies: PluginHostDependencies,
  fn: string,
  args: unknown,
  from: string,
): Promise<unknown> =>
  (await calls()).callPluginWorkerHost(dependencies, fn, args, from);

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
  (await calls()).callPluginExport(dependencies, fn, args, ms);

/** Runs one job in the install's durable Dynamic Worker. */
export const runPluginJob = async (
  dependencies: PluginHostDependencies,
  id: string,
  runId: string,
  data: unknown,
  ms?: number,
): Promise<unknown> =>
  (await calls()).runPluginJob(dependencies, id, runId, data, ms);

/**
 * Hands one watched message to the handler `ctx.watch` registered; says
 * `missing` when the isolate holding it is gone.
 */
export const sendPluginWatchMessage = async (
  dependencies: PluginHostDependencies,
  target: string,
  message: unknown,
): Promise<{ readonly missing: boolean }> =>
  (await calls()).sendPluginWatchMessage(dependencies, target, message);

/** The manifest's code block, decoded again where it leaves D1. */
export const decodePluginCode = (value: unknown) =>
  Schema.decodeUnknownOption(PluginBundleCode)(value);

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
