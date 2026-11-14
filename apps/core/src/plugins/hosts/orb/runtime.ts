import { RpcTarget } from "cloudflare:workers";
import { pluginHostEntry, TRUSTED_TIER, tierAtLeast } from "@dx/domain";
import { Effect } from "effect";
import { attachmentTransfer } from "../../../attachments/transfer.js";
import {
  DXD_PLUGIN_MAX_CALL_TIMEOUT_MS,
  DXD_PLUGIN_START_TIMEOUT_MS,
  type DxdPluginInvokeOperation,
  type DxdPluginResult,
} from "../../../execution/dxd/protocol.js";
import { pluginPackageKey } from "../../../settings/plugins/bundles/plugin-package.js";
import { insertPluginAudit } from "../../audit/audit.js";
import { configuredTierLimits } from "../../trust/limits.js";
import {
  callTier,
  type PluginCallInfo,
  type PluginHost,
  type PluginHostDependencies,
} from "../../worker-host/host.js";
import {
  COMMAND_TIMEOUT_MS,
  HANDLER_TIMEOUT_MS,
  HOST_CALL_TIMEOUT_MS,
  PANE_MESSAGE_TIMEOUT_MS,
  TOOL_TIMEOUT_MS,
} from "../../worker-host/runtime.js";
import {
  gateWorkdirOf,
  openThreadWorkspace,
  PluginShellRefused,
  SHELL_RUNS_PER_CALL,
  shellCommandOf,
  shellProgramOf,
  shellWorkdirOf,
} from "../../worker-host/shell.js";
import { withHost } from "../../worker-host/worker-calls.js";
import { logPluginHostCall, registerPluginHost } from "../registry.js";
import {
  PluginHostError,
  type PluginHostRuntime,
  type PluginHostTarget,
  type PluginInvocation,
} from "../types.js";
import type { OrbCapabilityTarget } from "./capability-relay.js";
import { orbRuntimeFiles } from "./runtime-files.js";
import type { OrbUsageBilling } from "./usage-batch.js";

/**
 * The Orb host: a plugin's `host.orb` entry runs as a
 * Node process that dxd supervises in the Thread's own Orb, with the
 * Thread's rights, its `binaries` installed, and its `panes[].connect.portal`
 * ports reachable through the Thread's Portal.
 *
 * Each call runs exactly like a Worker host call (`withHost`: the same
 * `PluginHost`, the same per-call limit, the same permission checks, audit
 * rows, and secret masking); only the code runs elsewhere. The process's
 * `ctx.*` calls come back through dxd and the Thread's execution object to
 * that one `PluginHost`, so the Orb process reaches nothing the Worker host
 * would not. Only trusted tiers get it.
 *
 * The process lives while a call runs or a pane holds a connection to one
 * of its ports, and a minute after (decision D4); the Orb sleeps on its own
 * schedule and the process wakes with it.
 */

/**
 * The PluginHost methods the Orb process may call: the QuickJS list without
 * `secret`. Any code with the Thread's rights in the Orb can act as the
 * process (it runs as the same user), so a plugin's secrets, which the
 * Thread itself never sees, stay with its Worker code.
 */
const CAPABILITIES = new Set([
  "log",
  "storageGet",
  "storageSet",
  "storageDelete",
  "storageList",
  "settings",
  "fetch",
  "callTool",
  "generate",
  "createThread",
  "runAgent",
  "exec",
  "uiPrompt",
  "uiNotify",
  "createQuickAction",
  "removeQuickAction",
  "paneOpen",
  "panePost",
  "threadInfo",
  "threadMessages",
  "threadPost",
  "hostCall",
]);

const BYTES = "$dxBytes";
const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
};
const encodeBytes = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer)
    return { [BYTES]: toBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value))
    return {
      [BYTES]: toBase64(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
    };
  if (Array.isArray(value)) return value.map(encodeBytes);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeBytes(item)]),
    );
  return value;
};
const decodeBytes = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const bytes = record[BYTES];
    if (typeof bytes === "string" && Object.keys(record).length === 1)
      return Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0)).buffer;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decodeBytes(item)]),
    );
  }
  return value;
};

/**
 * The calling Worker's capabilities, handed to the execution object for
 * one call: an allowlist in front of the call's `PluginHost`.
 */
export class OrbCapabilities extends RpcTarget implements OrbCapabilityTarget {
  readonly #host: PluginHost;
  readonly #dependencies: PluginHostDependencies;
  #workspace: ReturnType<typeof openThreadWorkspace> | undefined;
  #shellRuns = 0;
  constructor(host: PluginHost, dependencies: PluginHostDependencies) {
    super();
    this.#host = host;
    this.#dependencies = dependencies;
  }

  /**
   * The Orb host's streaming `ctx.$`: the process runs the command itself
   * and streams its output, but only after this admits it, with the Worker
   * host's checks: `permissions.shell`, the Thread's `tool.call` plugins
   * (which may refuse, rewrite, or answer it), and a `shell.exec` audit row.
   */
  async #shellAdmit(raw: unknown) {
    const { install, threadId, shellGate, db, ownerUserId } =
      this.#dependencies;
    if (install.code.permissions.shell !== true)
      throw new Error(`${install.name} was not granted running commands.`);
    if (threadId === undefined || shellGate === undefined)
      throw new Error(
        "dx runs a plugin's commands only where it can check them against the Thread's tool.call plugins, and this call is not one of those.",
      );
    const request = (
      typeof raw === "object" && raw !== null ? raw : {}
    ) as Record<string, unknown>;
    let command = shellCommandOf(request.command);
    if (++this.#shellRuns > SHELL_RUNS_PER_CALL)
      throw new PluginShellRefused(
        `A plugin call runs at most ${SHELL_RUNS_PER_CALL} commands.`,
      );
    this.#workspace ??= openThreadWorkspace(threadId);
    const sandbox = await this.#workspace;
    const checkout = sandbox.cwd.replace(/\/+$/, "");
    const relative = shellWorkdirOf(request.cwd);
    let workdir = relative === "." ? checkout : `${checkout}/${relative}`;
    const audit = (
      outcome: "success" | "rejected",
      detail: Record<string, unknown>,
    ) =>
      insertPluginAudit(db, {
        pluginId: install.pluginId,
        pluginName: install.name,
        pluginVersion: install.version,
        scope: install.scope,
        ownerUserId,
        threadId,
        action: "shell.exec",
        target: threadId,
        outcome,
        detail: {
          program: shellProgramOf(command),
          host: "orb",
          stream: true,
          ...detail,
        },
      });
    const decision = await shellGate({ command, workdir }, sandbox);
    if (decision.kind === "reject") {
      await audit("rejected", { by: "tool.call" });
      throw new PluginShellRefused(decision.message);
    }
    if (decision.kind === "synthesize") {
      await audit("success", { synthesized: true });
      return {
        kind: "synthesize",
        output:
          typeof decision.output === "string"
            ? decision.output
            : JSON.stringify(decision.output ?? null),
      };
    }
    if (decision.input.command !== undefined)
      command = shellCommandOf(decision.input.command);
    if (decision.input.workdir !== undefined)
      workdir = gateWorkdirOf(checkout, decision.input.workdir);
    await audit("success", { admitted: true });
    return { kind: "run", command, workdir };
  }

  async call(method: string, args: ReadonlyArray<unknown>) {
    if (method === "shellAdmit") return this.#shellAdmit(args[0]);
    if (method === "secret")
      throw new Error(
        "Secrets stay with the plugin's Worker code; the Orb host does not get them.",
      );
    if (!CAPABILITIES.has(method))
      throw new Error(`dx has no capability named ${method}.`);
    const target = (this.#host as unknown as Record<string, unknown>)[method];
    if (typeof target !== "function")
      throw new Error(`dx has no capability named ${method}.`);
    const value: unknown = await (
      target as (...values: unknown[]) => Promise<unknown>
    ).apply(this.#host, decodeBytes(args) as unknown[]);
    return encodeBytes(value);
  }
}

/** The ports a pane may frame through the Portal (`panes[].connect`). */
const portsOf = (code: PluginHostDependencies["install"]["code"]) => [
  ...new Set((code.paneConnect ?? []).flatMap(({ portal }) => portal)),
];

const sha256Hex = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const refused = (
  reason: PluginHostError["reason"],
  message: string,
): PluginHostError => new PluginHostError({ host: "orb", reason, message });

/** What one invocation runs in the process, and for how long. */
const methodOf = (
  call: PluginInvocation,
):
  | {
      readonly method: DxdPluginInvokeOperation["call"]["method"];
      readonly args: ReadonlyArray<unknown>;
      readonly ms: number;
      readonly what: string;
    }
  | undefined => {
  switch (call.kind) {
    case "host-call":
      return {
        method: "hostCall",
        args: [call.fn, call.args ?? null, call.from],
        ms: HOST_CALL_TIMEOUT_MS,
        what: `The exposed function ${call.fn}`,
      };
    case "export":
      return {
        method: "hostCall",
        args: [call.fn, call.args ?? null, "worker"],
        ms: HOST_CALL_TIMEOUT_MS,
        what: `The exported function ${call.fn}`,
      };
    case "event":
      return {
        method: "dispatch",
        args: [call.event, call.payload],
        ms: HANDLER_TIMEOUT_MS * 4,
        what: `The ${call.event} handlers`,
      };
    case "tool":
      return {
        method: "callTool",
        args: [call.name, call.input],
        ms: TOOL_TIMEOUT_MS,
        what: `The tool ${call.name}`,
      };
    case "command":
      return {
        method: "runCommand",
        args: [call.id],
        ms: COMMAND_TIMEOUT_MS,
        what: `The command ${call.id}`,
      };
    case "pane-message":
      return {
        method: "paneMessage",
        args: [call.paneId, call.message],
        ms: PANE_MESSAGE_TIMEOUT_MS,
        what: `The pane ${call.paneId}'s onMessage`,
      };
    case "job":
      return undefined;
  }
};

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
      billing?: OrbUsageBilling,
    ): Promise<
      | DxdPluginResult
      | {
          readonly kind: "daemon";
          readonly outcome: "known" | "unknown" | "outdated" | "invalid";
        }
    >;
  };
};

/** The key of an install's process: a change to any of it starts anew. */
const processKey = async (
  dependencies: PluginHostDependencies,
  runtimeSha256: string,
  entry: string,
  ports: ReadonlyArray<number>,
) =>
  `orb-${(
    await sha256Hex(
      JSON.stringify([
        dependencies.install.pluginId,
        dependencies.install.integrity,
        runtimeSha256,
        entry,
        dependencies.install.code.binaries ?? [],
        ports,
      ]),
    )
  ).slice(0, 48)}`;

const invokeOrb = async (
  dependencies: PluginHostDependencies,
  target: PluginHostTarget,
  call: PluginInvocation,
): Promise<unknown> => {
  const { install, bindings } = dependencies;
  const tier = callTier(dependencies);
  if (
    !tierAtLeast(tier, TRUSTED_TIER) ||
    !configuredTierLimits(bindings, tier).hosts.includes("orb")
  )
    throw refused(
      "blocked-tier",
      `The Orb host needs a trusted tier; ${install.name} runs as ${tier} here.`,
    );
  // The process has the Thread's files, environment, and secrets, as its
  // commands do: only an install reviewed with shell gets it.
  if (install.code.permissions.shell !== true)
    throw refused(
      "not-declared",
      `${install.name} runs in the Orb only with permissions.shell: the process has the Thread's files, environment, and secrets.`,
    );
  const entry = pluginHostEntry(install.code, "orb");
  if (entry === undefined)
    throw refused(
      "not-declared",
      `${install.name} has no Orb code: its manifest's host names no orb entry.`,
    );
  const threadId = target.threadId ?? dependencies.threadId;
  if (threadId === undefined)
    throw refused(
      "unavailable",
      "The Orb host runs in a Thread's Orb, and this call has no Thread.",
    );
  if (install.package === undefined)
    throw refused(
      "unavailable",
      `${install.name}'s files were not kept for the Orb; install the plugin again.`,
    );
  const transfer = attachmentTransfer(bindings);
  const execution = executionOf(dependencies, threadId);
  if (transfer === undefined || execution === undefined)
    throw refused("unavailable", "This deployment has no Orbs.");
  const run = methodOf(call);
  if (run === undefined)
    throw refused("failed", "Jobs run in the durable host, not the Orb host.");
  const callMs = Math.min(
    configuredTierLimits(bindings, tier).callMs,
    DXD_PLUGIN_MAX_CALL_TIMEOUT_MS,
    // The runtime limits each kind of call itself; dxd adds a margin.
    run.ms + 5_000,
  );
  const runtime = await orbRuntimeFiles(entry);
  const ports = portsOf(install.code);
  const key = await processKey(dependencies, runtime.sha256, entry, ports);
  const packageUrl = await transfer.readUrl(
    pluginPackageKey(install.package.sha256),
    { contentType: "application/octet-stream", disposition: "attachment" },
  );
  const operation = (info: PluginCallInfo, withFiles: boolean) =>
    ({
      operation: "plugin.invoke",
      process: {
        key,
        installId: install.pluginId,
        name: install.name,
        integrity: install.integrity,
        package: {
          url: packageUrl,
          sha256: install.package?.sha256 ?? "",
          size: install.package?.size ?? 0,
        },
        entry,
        runtime: withFiles
          ? { sha256: runtime.sha256, files: runtime.files }
          : { sha256: runtime.sha256 },
        binaries: install.code.binaries ?? [],
        ports,
      },
      call: {
        method: run.method,
        args: encodeBytes(run.args) as ReadonlyArray<unknown>,
        info,
      },
      // withHost keeps the precise limit, and pauses it while a person
      // answers a prompt; dxd only bounds a call that outlives it.
      timeoutMs: DXD_PLUGIN_MAX_CALL_TIMEOUT_MS,
    }) satisfies DxdPluginInvokeOperation;
  // Installing binaries and starting may take minutes the first time; the
  // call's own limit runs in dxd once the process is ready.
  return withHost(
    dependencies,
    DXD_PLUGIN_START_TIMEOUT_MS + callMs,
    `${install.name}'s Orb code`,
    async (info, host) => {
      const capabilities = new OrbCapabilities(host, dependencies);
      // The execution object batches usage; nothing is written per call.
      const billing: OrbUsageBilling = {
        pluginId: install.pluginId,
        pluginName: install.name,
        scope: install.scope,
        ...(install.scope === "workspace"
          ? { workspaceId: install.targetId }
          : {}),
        ownerUserId:
          install.scope === "personal"
            ? install.targetId
            : dependencies.ownerUserId,
        threadId,
      };
      let result = await execution.orbPlugin(
        threadId,
        operation(info, false),
        capabilities,
        billing,
      );
      // dxd keeps runtimes by digest; the first call to a new one sends it.
      if (result.kind === "unavailable" && result.reason === "runtime")
        result = await execution.orbPlugin(
          threadId,
          operation(info, true),
          capabilities,
          billing,
        );
      switch (result.kind) {
        case "result":
          return decodeBytes(result.value);
        case "error":
          throw refused("failed", result.message);
        case "unavailable":
          throw refused(
            result.reason === "busy" ? "quota" : "failed",
            result.message,
          );
        case "daemon":
          throw refused(
            "unavailable",
            result.outcome === "outdated"
              ? "This Thread's dx daemon predates the Orb host and has not updated yet. Try again in a minute."
              : result.outcome === "invalid"
                ? "dx could not send this call to the Orb: its request was not valid."
                : "This Thread's Orb is not reachable right now.",
          );
        default:
          throw refused("failed", "The Orb answered something dx cannot read.");
      }
    },
  );
};

const orbHost = ({
  dependencies,
}: {
  readonly dependencies: PluginHostDependencies;
}): PluginHostRuntime => {
  const logCall = (
    target: PluginHostTarget,
    call: PluginInvocation["kind"],
    started: number,
    outcome: string,
    detail?: string,
  ) =>
    logPluginHostCall({
      requestId: dependencies.requestId,
      installId: target.installId,
      host: "orb",
      tier: target.tier,
      call,
      outcome,
      ms: Date.now() - started,
      threadId: target.threadId ?? dependencies.threadId,
      detail,
    });
  const control = async (
    target: PluginHostTarget,
    operation: unknown,
  ): Promise<DxdPluginResult | undefined> => {
    const threadId = target.threadId ?? dependencies.threadId;
    if (threadId === undefined) return undefined;
    const execution = executionOf(dependencies, threadId);
    if (execution === undefined) return undefined;
    const result = await execution.orbPlugin(threadId, operation);
    return result.kind === "daemon" ? undefined : result;
  };
  const keyOf = async (target: PluginHostTarget) => {
    const entry = pluginHostEntry(dependencies.install.code, "orb");
    if (entry === undefined) return undefined;
    const runtime = await orbRuntimeFiles(entry);
    return processKey(
      dependencies,
      runtime.sha256,
      entry,
      portsOf(dependencies.install.code),
    ).then((key) => (target.integrity === "" ? undefined : key));
  };
  return {
    kind: "orb",
    invoke: (target, call) => {
      const started = Date.now();
      // PluginHost.hostCall already logs a host-call, with its caller.
      const logged = call.kind !== "host-call";
      const log = (...args: Parameters<typeof logCall>) => {
        if (logged) logCall(...args);
      };
      return Effect.tryPromise({
        try: () => invokeOrb(dependencies, target, call),
        catch: (error) =>
          error instanceof PluginHostError
            ? error
            : refused(
                "failed",
                error instanceof Error ? error.message : String(error),
              ),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => log(target, call.kind, started, "ok")),
        ),
        Effect.tapError((error) =>
          Effect.sync(() =>
            log(
              target,
              call.kind,
              started,
              error.reason,
              error.message.slice(0, 300),
            ),
          ),
        ),
      );
    },
    status: (target) =>
      Effect.promise(async () => {
        const key = await keyOf(target);
        const result =
          key === undefined
            ? undefined
            : await control(target, { operation: "plugin.status", key }).catch(
                () => undefined,
              );
        return result?.kind === "status"
          ? { state: result.state, since: result.since }
          : { state: "cold" as const, since: Date.now() };
      }),
    stop: (target, reason) =>
      Effect.promise(async () => {
        await control(target, {
          operation: "plugin.stop",
          installId: target.installId,
          reason,
        }).catch(() => undefined);
      }),
  };
};

registerPluginHost("orb", orbHost);
