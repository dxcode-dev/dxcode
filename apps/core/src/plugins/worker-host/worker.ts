import {
  PLUGIN_PANE_MAX_HTML_BYTES,
  PLUGIN_PROMPT_MAX_SECONDS,
  PluginCommand,
  PluginLinkPattern,
  PluginPaneId,
} from "@dx/api";
import { PluginBundleCode, type PluginCodeEvent } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  type PluginAgentDefinition,
  pluginAgentDefinitionOf,
} from "../agents/definition.js";
import {
  type PluginCallInfo,
  PluginHost,
  type PluginHostDependencies,
  type PluginInstallRecord,
  pluginCallInfo,
} from "./host.js";
import { runPluginInQuickJS } from "./quickjs-host.js";
import {
  API_MODULE,
  apiModuleSource,
  COMMAND_TIMEOUT_MS,
  HANDLER_TIMEOUT_MS,
  linkApiImports,
  PANE_MESSAGE_TIMEOUT_MS,
  RUNTIME_MODULE,
  runtimeModuleSource,
  TOOL_TIMEOUT_MS,
} from "./runtime.js";

/**
 * Plugin code runs in Cloudflare Dynamic Workers (`LOADER`). One worker per
 * plugin version and install owner: a personal install's worker serves only
 * that person; a workspace install's worker serves the workspace's members.
 * `LOADER.get` reuses a warm worker with the same ID, so dx never starts a
 * worker per call. The worker has no network, bindings, or storage; each
 * call hands it a {@link PluginHost} for what the install was granted.
 */

const logger = getLogger(["dx", "plugins", "worker-host"]);

/** The compatibility date plugin workers run on. */
export const PLUGIN_WORKER_COMPATIBILITY_DATE = "2026-08-20";

/** Bump to restart every plugin worker when the runtime module changes. */
const RUNTIME_GENERATION = 9;

export const pluginWorkerId = (install: {
  readonly integrity: string;
  readonly scope: string;
  readonly targetId: string;
}) =>
  `dxp${RUNTIME_GENERATION}:${install.integrity}:${install.scope}:${install.targetId}`;

/** What `describe()` reports about the code. */
export interface PluginCodeDescription {
  readonly events: ReadonlyArray<PluginCodeEvent>;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }>;
  readonly commands: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description?: string;
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
  }>;
  /**
   * Agent modes the code registered that its manifest declares and its
   * grants allow, each agent checked as dx checks any plugin agent.
   */
  readonly agentModes: ReadonlyArray<{
    readonly key: string;
    readonly agent: PluginAgentDefinition;
  }>;
}

interface PluginEntrypoint {
  describe(): Promise<unknown>;
  dispatch(
    event: string,
    payload: unknown,
    call: PluginCallInfo,
    host: PluginHost,
  ): Promise<unknown>;
  callTool(
    name: string,
    input: unknown,
    call: PluginCallInfo,
    host: PluginHost,
  ): Promise<unknown>;
  runCommand(
    id: string,
    call: PluginCallInfo,
    host: PluginHost,
  ): Promise<unknown>;
  paneMessage(
    id: string,
    message: unknown,
    call: PluginCallInfo,
    host: PluginHost,
  ): Promise<unknown>;
}

export class PluginHostUnavailable extends Error {
  override readonly name = "PluginHostUnavailable";
}

const loaderOf = (bindings: Bindings): WorkerLoader => {
  const loader = bindings.LOADER;
  if (loader === undefined)
    throw new PluginHostUnavailable(
      "This deployment has no Dynamic Worker loader, so plugin code cannot run here. Its operator may run plugin code in QuickJS with DX_PLUGIN_HOST=quickjs.",
    );
  return loader;
};

const sha256Hex = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** The version's stored modules, checked against the manifest's hashes. */
const loadModules = async (db: D1Database, install: PluginInstallRecord) => {
  const rows = await (install.scope === "repository"
    ? db
        .prepare(
          `SELECT path, content, integrity FROM repository_plugin_file
            WHERE bundle_integrity = ?`,
        )
        .bind(install.integrity)
    : db
        .prepare(
          `SELECT path, content, integrity FROM trusted_plugin_file
            WHERE plugin_id = ? AND version = ?`,
        )
        .bind(install.pluginId, install.version)
  ).all<{ path: string; content: string; integrity: string }>();
  const byPath = new Map(rows.results.map((row) => [row.path, row]));
  const modules: Record<string, { js: string }> = {};
  for (const declared of install.code.modules) {
    const row = byPath.get(declared.path);
    if (
      row === undefined ||
      row.integrity !== declared.integrity ||
      // Nobody reviewed a repository plugin's rows; hash what loads.
      (install.scope === "repository" &&
        (await sha256Hex(row.content)) !== declared.integrity)
    )
      throw new PluginHostUnavailable(
        `${install.name}'s stored code does not match its reviewed version (${declared.path}).`,
      );
    modules[declared.path] = { js: linkApiImports(row.path, row.content) };
  }
  return modules;
};

/**
 * Without the Dynamic Worker loader, each call runs the same runtime and
 * modules in a fresh QuickJS runtime inside this Worker (quickjs-host.ts).
 */
const quickJSEntrypoint = (
  db: D1Database,
  install: PluginInstallRecord,
): PluginEntrypoint => {
  const modules = async () => {
    const loaded = await loadModules(db, install);
    return {
      [RUNTIME_MODULE]: runtimeModuleSource(install.code.entry),
      [API_MODULE]: apiModuleSource,
      ...Object.fromEntries(
        Object.entries(loaded).map(([path, { js }]) => [path, js]),
      ),
    };
  };
  return {
    describe: async () =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "describe" },
        wallMs: HANDLER_TIMEOUT_MS,
      }),
    dispatch: async (event, payload, call, host) =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "dispatch", event, payload },
        call,
        host,
        wallMs: HANDLER_TIMEOUT_MS * 2,
      }),
    callTool: async (name, input, call, host) =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "callTool", name, input },
        call,
        host,
        wallMs: TOOL_TIMEOUT_MS,
      }),
    runCommand: async (id, call, host) =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "runCommand", id },
        call,
        host,
        wallMs: COMMAND_TIMEOUT_MS,
      }),
    paneMessage: async (id, message, call, host) =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "paneMessage", id, message },
        call,
        host,
        wallMs: PANE_MESSAGE_TIMEOUT_MS,
      }),
  };
};

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

const entrypoint = (
  bindings: Bindings,
  db: D1Database,
  install: PluginInstallRecord,
): PluginEntrypoint => {
  if (pluginHostKind(bindings) === "quickjs")
    return quickJSEntrypoint(db, install);
  const stub = loaderOf(bindings).get(pluginWorkerId(install), async () => ({
    compatibilityDate: PLUGIN_WORKER_COMPATIBILITY_DATE,
    // AsyncLocalStorage, so agent.run finds the call it runs in.
    compatibilityFlags: ["nodejs_als"],
    mainModule: RUNTIME_MODULE,
    modules: {
      [RUNTIME_MODULE]: { js: runtimeModuleSource(install.code.entry) },
      [API_MODULE]: { js: apiModuleSource },
      ...(await loadModules(db, install)),
    },
    env: {},
    globalOutbound: null,
  }));
  return stub.getEntrypoint() as unknown as PluginEntrypoint;
};

const within = <A>(ms: number, what: string, promise: Promise<A>) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${what} took longer than ${ms / 1_000} seconds.`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const DescriptionSchema = Schema.Struct({
  events: Schema.Array(Schema.String),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      inputSchema: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  commands: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.optional(Schema.String),
    }),
  ),
  linkPatterns: Schema.Array(
    Schema.Struct({
      pattern: Schema.String,
      flags: Schema.optional(Schema.String),
      url: Schema.String,
      title: Schema.optional(Schema.String),
    }),
  ),
  // Absent from a worker that started before panes existed.
  panes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        html: Schema.String,
        handlesMessages: Schema.Boolean,
      }),
    ),
  ),
  // Absent from a worker that started before plugin agents existed.
  agentModes: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, agent: Schema.Unknown })),
  ),
});

/** The longest a prompt waits, plus a margin for its last poll. */
const PROMPT_CEILING_MS = (PLUGIN_PROMPT_MAX_SECONDS + 30) * 1_000;

const decodeCommand = Schema.decodeUnknownOption(PluginCommand);
const decodePaneId = Schema.decodeUnknownOption(PluginPaneId);
const decodeLinkPattern = Schema.decodeUnknownOption(PluginLinkPattern);

/**
 * A quantified group that is itself quantified, such as `(a+)+` or
 * `(a|aa)*`, can take exponential time on a near-miss; such a pattern
 * would freeze every viewer's page.
 */
const NESTED_QUANTIFIER =
  /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]|\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{]/;

/** Whether a link pattern is one dx shows: bounded, https, and safe to run. */
const safeLinkPattern = (link: {
  readonly pattern: string;
  readonly flags?: string;
  readonly url: string;
}) => {
  if (!link.url.startsWith("https://") || NESTED_QUANTIFIER.test(link.pattern))
    return false;
  try {
    new RegExp(link.pattern, link.flags ?? "");
    return true;
  } catch {
    return false;
  }
};

/** Cached per worker ID: the same code describes itself the same way. */
const descriptions = new Map<string, Promise<PluginCodeDescription>>();

/**
 * Starts (or reuses) the install's worker and asks what its code handles.
 * Events the manifest does not grant are dropped: dx never sends them.
 */
export const describePlugin = (
  bindings: Bindings,
  db: D1Database,
  install: PluginInstallRecord,
): Promise<PluginCodeDescription> => {
  const id = pluginWorkerId(install);
  const cached = descriptions.get(id);
  if (cached !== undefined) return cached;
  const described = within(
    HANDLER_TIMEOUT_MS,
    `Starting ${install.name}`,
    entrypoint(bindings, db, install).describe(),
  ).then((raw) => {
    const decoded = Schema.decodeUnknownSync(DescriptionSchema)(raw);
    const granted = new Set<string>(install.code.permissions.events);
    return {
      events: decoded.events.filter((event) =>
        granted.has(event),
      ) as ReadonlyArray<PluginCodeEvent>,
      tools: decoded.tools.slice(0, 32),
      // Checked here too: the plugin's isolate is the plugin's to change.
      commands: decoded.commands
        .filter((command) =>
          Option.isSome(decodeCommand({ ...command, plugin: install.name })),
        )
        .slice(0, 16),
      linkPatterns: decoded.linkPatterns
        .filter(
          (link) =>
            Option.isSome(
              decodeLinkPattern({ ...link, plugin: install.name }),
            ) && safeLinkPattern(link),
        )
        .slice(0, 16),
      // Checked here too, as commands are.
      panes: (decoded.panes ?? [])
        .filter(
          (pane) =>
            Option.isSome(decodePaneId(pane.id)) &&
            pane.title.length >= 1 &&
            pane.title.length <= 40 &&
            new TextEncoder().encode(pane.html).byteLength <=
              PLUGIN_PANE_MAX_HTML_BYTES,
        )
        .slice(0, 4),
      agentModes: agentModesOf(install, decoded.agentModes ?? []),
    };
  });
  descriptions.set(id, described);
  described.catch(() => descriptions.delete(id));
  return described;
};

/**
 * The registered modes dx lists: declared in the manifest's `agentModes`,
 * granted `permissions.agents`, and each agent valid for the install. One
 * that is not is left out and logged, not run half-checked.
 */
const agentModesOf = (
  install: PluginInstallRecord,
  registered: ReadonlyArray<{ readonly key: string; readonly agent: unknown }>,
) => {
  if (install.code.permissions.agents !== true) return [];
  const declared = new Set(
    (install.code.agentModes ?? []).map(({ key }) => key),
  );
  return registered.flatMap(({ key, agent }) => {
    if (!declared.has(key)) {
      logger.warn(
        `Plugin ${install.name} registered an undeclared agent mode.`,
        {
          event: "plugin_agent_mode_undeclared",
          pluginId: install.pluginId,
          mode: key,
        },
      );
      return [];
    }
    try {
      return [{ key, agent: pluginAgentDefinitionOf(install.code, agent) }];
    } catch (error) {
      logger.warn(`Plugin ${install.name}'s agent mode ${key} is invalid.`, {
        event: "plugin_agent_mode_invalid",
        pluginId: install.pluginId,
        mode: key,
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
};

/**
 * Runs one call into the install's worker within `ms`, a limit that stops
 * while one of its prompts waits on a person (the prompt has its own). A
 * call asks one prompt at a time, and however it asks, it never runs past
 * `ms` plus the longest prompt.
 */
const withHost = async <A>(
  dependencies: PluginHostDependencies,
  ms: number,
  what: string,
  run: (call: PluginCallInfo, host: PluginHost) => Promise<A>,
) => {
  let remaining = ms;
  let started = 0;
  let waiting = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: (error: Error) => void = () => undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const ceiling = setTimeout(
    () =>
      fail(
        new Error(
          `${what} took longer than ${(ms + PROMPT_CEILING_MS) / 1_000} seconds.`,
        ),
      ),
    ms + PROMPT_CEILING_MS,
  );
  const start = () => {
    started = Date.now();
    timer = setTimeout(
      () => fail(new Error(`${what} took longer than ${ms / 1_000} seconds.`)),
      remaining,
    );
  };
  const host = new PluginHost({
    ...dependencies,
    humanWait: {
      start() {
        if (waiting++ > 0) return;
        clearTimeout(timer);
        remaining -= Date.now() - started;
      },
      end() {
        if (--waiting === 0) start();
      },
    },
  });
  start();
  try {
    return await Promise.race([
      run(pluginCallInfo(dependencies), host),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(ceiling);
    // A prompt that ends after the call must not start the limit again.
    waiting = Number.POSITIVE_INFINITY;
    host.close();
  }
};

/** Sends one event to the install's worker and returns its combined result. */
export const dispatchPluginEvent = (
  dependencies: PluginHostDependencies,
  event: PluginCodeEvent,
  payload: unknown,
  /** The worker times each handler; this bounds a worker that never answers. */
  timeoutMs = HANDLER_TIMEOUT_MS * 4,
): Promise<unknown> =>
  withHost(
    dependencies,
    timeoutMs,
    `${dependencies.install.name}'s ${event} handlers`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
      ).dispatch(event, payload, call, host),
  );

/** Runs one of the install's registered tools. */
export const callPluginTool = (
  dependencies: PluginHostDependencies,
  name: string,
  input: unknown,
): Promise<unknown> =>
  withHost(
    dependencies,
    TOOL_TIMEOUT_MS + 5_000,
    `${dependencies.install.name}'s ${name} tool`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
      ).callTool(name, input, call, host),
  );

/** Runs one of the install's palette commands. */
export const runPluginCommand = (
  dependencies: PluginHostDependencies,
  id: string,
): Promise<unknown> =>
  withHost(
    dependencies,
    COMMAND_TIMEOUT_MS + 5_000,
    `${dependencies.install.name}'s ${id} command`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
      ).runCommand(id, call, host),
  );

/**
 * Runs one of the install's panes' `onMessage` for a message its view sent
 * with `dx/plugin.post`, and returns its result.
 */
export const sendPaneMessage = (
  dependencies: PluginHostDependencies,
  id: string,
  message: unknown,
): Promise<unknown> =>
  withHost(
    dependencies,
    PANE_MESSAGE_TIMEOUT_MS + 5_000,
    `${dependencies.install.name}'s ${id} pane`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
      ).paneMessage(id, message, call, host),
  );

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
