import {
  DXD_PLUGIN_MAX_CALL_TIMEOUT_MS,
  DXD_PLUGIN_START_TIMEOUT_MS,
  type DxdPluginInvokeOperation,
  type DxdPluginResult,
} from "../../execution/dxd/protocol.js";
import type { OrbCapabilityTarget } from "../hosts/orb/capability-relay.js";
import {
  decodeBytes,
  encodeBytes,
  OrbCapabilities,
  orbMethodOf,
} from "../hosts/orb/runtime.js";
import { orbRuntimeFiles } from "../hosts/orb/runtime-files.js";
import type { PluginInvocation } from "../hosts/types.js";
import type {
  PluginCallInfo,
  PluginHostDependencies,
} from "../worker-host/host.js";
import { HANDLER_TIMEOUT_MS } from "../worker-host/runtime.js";
import type { PluginCodeDescription } from "../worker-host/worker.js";
import {
  decodePluginDescription,
  withHost,
} from "../worker-host/worker-calls.js";

/**
 * Running a draft plugin's code. A draft (`dxd plugin load <folder>`) runs
 * as the Orb host's Node process, started by dxd from the folder itself in
 * the Thread's own Orb: nothing is uploaded, installed, or run inside dx,
 * and no other Thread reaches it. Each call goes through `withHost`, so the
 * process's `ctx.*` calls reach the same `PluginHost`, permission checks,
 * and audit rows as any plugin's; on top of the Orb host's capabilities a
 * draft may read its granted secrets, which dx checked at load are ones the
 * Thread's own commands already receive.
 */

type DraftCall = PluginInvocation | { readonly kind: "describe" };

const sha256Hex = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The install id dx gives a draft; dxd names its log after it. */
export const draftInstallId = async (name: string) =>
  `plg_draft-${(await sha256Hex(name)).slice(0, 12)}`;

const executionOf = (
  dependencies: PluginHostDependencies,
  threadId: string,
) => {
  const namespace = dependencies.bindings.THREAD_EXECUTION;
  if (namespace === undefined) return undefined;
  return namespace.get(namespace.idFromName(threadId)) as unknown as {
    orbPlugin(
      threadId: string,
      operation: unknown,
      capabilities?: OrbCapabilityTarget,
    ): Promise<
      | DxdPluginResult
      | {
          readonly kind: "daemon";
          readonly outcome: "known" | "unknown" | "outdated" | "invalid";
        }
    >;
  };
};

const runOf = (call: DraftCall) =>
  call.kind === "describe"
    ? {
        method: "describe" as const,
        args: [] as ReadonlyArray<unknown>,
        ms: HANDLER_TIMEOUT_MS,
        what: "Starting its code",
      }
    : orbMethodOf(call);

/** Runs one call in the draft's process, starting it from its folder. */
export const invokeDraft = async (
  dependencies: PluginHostDependencies,
  call: DraftCall,
): Promise<unknown> => {
  const { install } = dependencies;
  const draft = install.draft;
  if (draft === undefined)
    throw new Error(`${install.name} is not a draft plugin.`);
  const threadId = dependencies.threadId ?? draft.threadId;
  // A draft acts only in the Thread that loaded it.
  if (threadId !== draft.threadId)
    throw new Error(
      `${install.displayName} is a draft loaded in another Thread; it runs only there.`,
    );
  const run = runOf(call);
  if (run === undefined)
    throw new Error(
      "A draft plugin has no jobs; keep the plugin to run them on a schedule.",
    );
  // A view's own `call` reaches the draft's exposed functions; another
  // plugin's `ctx.plugins.call` and `ctx.host` do not until it is kept.
  if (
    call.kind === "host-call" ||
    (call.kind === "export" && call.callerPlugin !== "")
  )
    throw new Error(
      `${install.displayName} is a draft: it runs only its entry module in this Orb, so ctx.host and other plugins' calls reach it once it is kept.`,
    );
  const execution = executionOf(dependencies, threadId);
  if (execution === undefined) throw new Error("This deployment has no Orbs.");
  const entry = install.code.entry;
  if (entry === undefined)
    throw new Error(
      `${install.displayName} has no entry module to run in this Orb.`,
    );
  const runtime = await orbRuntimeFiles(entry);
  // A reload is a new integrity: the old process stops, as for an update.
  const key = `draft-${(
    await sha256Hex(
      JSON.stringify([install.pluginId, install.integrity, runtime.sha256]),
    )
  ).slice(0, 48)}`;
  const callMs = Math.min(DXD_PLUGIN_MAX_CALL_TIMEOUT_MS, run.ms + 5_000);
  const operation = (info: PluginCallInfo, withFiles: boolean) =>
    ({
      operation: "plugin.invoke",
      process: {
        key,
        installId: install.pluginId,
        name: install.name,
        integrity: install.integrity,
        folder: draft.folder,
        entry,
        runtime: withFiles
          ? { sha256: runtime.sha256, files: runtime.files }
          : { sha256: runtime.sha256 },
        binaries: [],
        ports: [],
      },
      call: {
        method: run.method,
        args: encodeBytes(run.args) as ReadonlyArray<unknown>,
        info,
      },
      timeoutMs: DXD_PLUGIN_MAX_CALL_TIMEOUT_MS,
    }) satisfies DxdPluginInvokeOperation;
  return withHost(
    dependencies,
    DXD_PLUGIN_START_TIMEOUT_MS + callMs,
    `${install.displayName}'s code`,
    async (info, host) => {
      const capabilities = new OrbCapabilities(host, dependencies, {
        secrets: true,
      });
      let result = await execution.orbPlugin(
        threadId,
        operation(info, false),
        capabilities,
      );
      // dxd keeps runtimes by digest; the first call to a new one sends it.
      if (result.kind === "unavailable" && result.reason === "runtime")
        result = await execution.orbPlugin(
          threadId,
          operation(info, true),
          capabilities,
        );
      switch (result.kind) {
        case "result":
          return decodeBytes(result.value);
        case "error":
        case "unavailable":
          throw new Error(result.message);
        case "daemon":
          throw new Error(
            result.outcome === "outdated"
              ? "This Thread's dx daemon predates draft plugins and has not updated yet. Try again in a minute."
              : result.outcome === "invalid"
                ? "dx could not send this call to the Orb: its request was not valid."
                : "This Thread's Orb is not reachable right now.",
          );
        default:
          throw new Error("The Orb answered something dx cannot read.");
      }
    },
  );
};

/** Starts the draft's process and asks what its code registers. */
export const describeDraft = async (
  dependencies: PluginHostDependencies,
): Promise<PluginCodeDescription> =>
  decodePluginDescription(
    dependencies.install,
    await invokeDraft(dependencies, { kind: "describe" }),
  );
