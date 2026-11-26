import {
  PLUGIN_PROMPT_MAX_SECONDS,
  PluginCommand,
  PluginLinkPattern,
} from "@dx/api";
import {
  type PluginCodeEvent,
  type PluginHostKind,
  type PluginIconRef,
  pluginHostEntry,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { resolveItemIcon } from "../../settings/plugins/bundles/plugin-icon.js";
import { pluginAgentDefinitionOf } from "../agents/definition.js";
import { retryOnDynamicWorkerLimit } from "./concurrency.js";
import {
  type PluginCallInfo,
  PluginHost,
  type PluginHostDependencies,
  type PluginInstallRecord,
  pluginCallInfo,
  pluginCallMs,
} from "./host.js";
import { runPluginInQuickJS } from "./quickjs-host.js";
import {
  API_MODULE,
  apiModuleSource,
  COMMAND_TIMEOUT_MS,
  HANDLER_TIMEOUT_MS,
  HOST_CALL_TIMEOUT_MS,
  linkApiImports,
  RUNTIME_MODULE,
  runtimeModuleSource,
  TOOL_TIMEOUT_MS,
} from "./runtime.js";
import {
  PLUGIN_WORKER_COMPATIBILITY_DATE,
  type PluginCodeDescription,
  PluginHostUnavailable,
  pluginHostKind,
  pluginWorkerId,
} from "./worker.js";

/**
 * Plugin code runs in Cloudflare Dynamic Workers (`LOADER`). One worker per
 * plugin version and install owner: a personal install's worker serves only
 * that person; a workspace install's worker serves the workspace's members.
 * `LOADER.get` reuses a warm worker with the same ID, so dx never starts a
 * worker per call. The worker has no network, bindings, or storage; each
 * call hands it a {@link PluginHost} for what the install was granted.
 */

import { callPluginService, isServiceTool } from "../services/call.js";

const logger = getLogger(["dx", "plugins", "worker-host"]);

/** The entry module a host kind runs for the install. */
const hostEntry = (install: PluginInstallRecord, kind: PluginHostKind) => {
  const entry = pluginHostEntry(install.code, kind);
  if (entry === undefined)
    throw new PluginHostUnavailable(
      `${install.name} has no ${kind} code: its manifest's host names no ${kind} entry.`,
    );
  return entry;
};

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
  hostCall(
    fn: string,
    args: unknown,
    from: string,
    call: PluginCallInfo,
    host: PluginHost,
  ): Promise<unknown>;
  callExport(
    fn: string,
    args: unknown,
    call: PluginCallInfo,
    host: PluginHost,
    ms: number,
  ): Promise<unknown>;
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
  kind: PluginHostKind,
): PluginEntrypoint => {
  const modules = async () => {
    const loaded = await loadModules(db, install);
    return {
      [RUNTIME_MODULE]: runtimeModuleSource(hostEntry(install, kind)),
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
        wallMs: call.callMs ?? TOOL_TIMEOUT_MS,
      }),
    runCommand: async (id, call, host) =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "runCommand", id },
        call,
        host,
        wallMs: call.callMs ?? COMMAND_TIMEOUT_MS,
      }),
    hostCall: async (fn, args, from, call, host) =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "hostCall", fn, args, from },
        call,
        host,
        wallMs: call.callMs ?? HOST_CALL_TIMEOUT_MS,
      }),
    callExport: async (fn, args, call, host, ms) =>
      runPluginInQuickJS({
        modules: await modules(),
        operation: { kind: "callExport", fn, args, ms },
        call,
        host,
        wallMs: ms,
      }),
  };
};

const entrypoint = (
  bindings: Bindings,
  db: D1Database,
  install: PluginInstallRecord,
  kind: PluginHostKind = "worker",
): PluginEntrypoint => {
  if (pluginHostKind(bindings) === "quickjs")
    return quickJSEntrypoint(db, install, kind);
  const entry = hostEntry(install, kind);
  const stub = loaderOf(bindings).get(
    pluginWorkerId(install, kind),
    async () => ({
      compatibilityDate: PLUGIN_WORKER_COMPATIBILITY_DATE,
      // AsyncLocalStorage, so agent.run finds the call it runs in.
      compatibilityFlags: ["nodejs_als"],
      mainModule: RUNTIME_MODULE,
      modules: {
        [RUNTIME_MODULE]: { js: runtimeModuleSource(entry) },
        [API_MODULE]: { js: apiModuleSource },
        ...(await loadModules(db, install)),
      },
      env: {},
      globalOutbound: null,
    }),
  );
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
      icon: Schema.optional(Schema.String),
    }),
  ),
  commands: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.optional(Schema.String),
      icon: Schema.optional(Schema.String),
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
  exports: Schema.optional(Schema.Array(Schema.String)),
  // Absent from a worker that started before plugin agents existed.
  agentModes: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, agent: Schema.Unknown })),
  ),
});

/** The longest a prompt waits, plus a margin for its last poll. */
const PROMPT_CEILING_MS = (PLUGIN_PROMPT_MAX_SECONDS + 30) * 1_000;

const decodeCommand = Schema.decodeUnknownOption(PluginCommand);
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

/**
 * What a plugin's code says it handles, checked: events the manifest does
 * not grant are dropped (dx never sends them), and every item is bounded.
 * The Orb host's describe for a draft plugin reads it the same way.
 */
export const decodePluginDescription = (
  install: PluginInstallRecord,
  raw: unknown,
): PluginCodeDescription => {
  const decoded = Schema.decodeUnknownSync(DescriptionSchema)(raw);
  const granted = new Set<string>(install.code.permissions.events);
  return {
    events: decoded.events.filter((event) =>
      granted.has(event),
    ) as ReadonlyArray<PluginCodeEvent>,
    tools: decoded.tools.slice(0, 32).map(withItemIcon(install)),
    // Checked here too: the plugin's isolate is the plugin's to change.
    commands: decoded.commands
      .filter((command) =>
        Option.isSome(
          decodeCommand({
            id: command.id,
            title: command.title,
            ...(command.description === undefined
              ? {}
              : { description: command.description }),
            plugin: install.name,
          }),
        ),
      )
      .slice(0, 16)
      .map(withItemIcon(install)),
    linkPatterns: decoded.linkPatterns
      .filter(
        (link) =>
          Option.isSome(decodeLinkPattern({ ...link, plugin: install.name })) &&
          safeLinkPattern(link),
      )
      .slice(0, 16),
    exports: exportsOf(install, decoded.exports ?? []),
    agentModes: agentModesOf(install, decoded.agentModes ?? []),
  };
};

/** Cached per worker ID: the same code describes itself the same way. */
const descriptions = new Map<string, Promise<PluginCodeDescription>>();

/**
 * Starts (or reuses) the install's worker and asks what its code handles.
 * Events the manifest does not grant are dropped: dx never sends them.
 */
/** The tools an install's service answers, as `describe()` reports tools. */
const serviceTools = (install: PluginInstallRecord) =>
  (install.code.service?.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input ?? { type: "object", properties: {} },
  }));

/**
 * What the install's code handles: its Worker's `describe()`, plus the
 * tools its service answers. A plugin whose only code is a service starts
 * no Worker.
 */
export const describePlugin = async (
  bindings: Bindings,
  db: D1Database,
  install: PluginInstallRecord,
): Promise<PluginCodeDescription> => {
  const fromService = serviceTools(install);
  if (pluginHostEntry(install.code, "worker") === undefined)
    return {
      events: [],
      tools: fromService,
      commands: [],
      linkPatterns: [],
      panes: [],
      views: [],
      exports: [],
      agentModes: [],
    } as unknown as PluginCodeDescription;
  const described = await describeWorker(bindings, db, install);
  if (fromService.length === 0) return described;
  const names = new Set(fromService.map(({ name }) => name));
  return {
    ...described,
    tools: [
      ...fromService,
      ...described.tools.filter(({ name }) => !names.has(name)),
    ],
  };
};

const describeWorker = (
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
    retryOnDynamicWorkerLimit(() =>
      entrypoint(bindings, db, install).describe(),
    ),
  ).then((raw) => decodePluginDescription(install, raw));
  descriptions.set(id, described);
  described.catch(() => descriptions.delete(id));
  return described;
};

// --- Item icons ---

/** An item's registered icon resolved against the plugin's icon files. */
const withItemIcon =
  (install: PluginInstallRecord) =>
  <T extends { readonly icon?: string }>(
    item: T,
  ): T & { icon?: PluginIconRef } => {
    const { icon: raw, ...rest } = item;
    const icon = resolveItemIcon(raw, install.code.iconAssets);
    return { ...(rest as T), ...(icon === undefined ? {} : { icon }) };
  };

/**
 * The exposed functions the manifest's `exports` lists. An export the
 * manifest does not declare is left out: dx never serves what was not
 * shown at install.
 */
const exportsOf = (
  install: PluginInstallRecord,
  exposed: ReadonlyArray<string>,
) => {
  const exportNames = new Set(
    (install.code.exports ?? []).map(({ name }) => name),
  );
  return exposed.filter((name) => exportNames.has(name)).slice(0, 16);
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
export const withHost = async <A>(
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
    // A plugin call spends this call's time, never more.
    remainingMs: () =>
      waiting > 0 ? remaining : remaining - (Date.now() - started),
  });
  start();
  try {
    return await Promise.race([
      // Refused at the door by the per-request Dynamic Worker limit, the
      // call never started: wait for a slot and try again.
      retryOnDynamicWorkerLimit(() => run(pluginCallInfo(dependencies), host)),
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
        dependencies.currentHost,
      ).dispatch(event, payload, call, host),
  );

/**
 * Runs one of the install's tools: a tool its service answers goes to the
 * service on its plugin Orb (plugins/services/call.ts); any other runs in
 * its Worker.
 */
export const callPluginTool = async (
  dependencies: PluginHostDependencies,
  name: string,
  input: unknown,
): Promise<unknown> => {
  if (isServiceTool(dependencies.install, name)) {
    const result = await callPluginService(dependencies.bindings, {
      install: dependencies.install,
      kind: "tool",
      name,
      args: input,
      actorUserId: dependencies.actorUserId ?? dependencies.ownerUserId,
      ...(dependencies.threadId === undefined
        ? {}
        : { threadId: dependencies.threadId }),
    });
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }
  return callWorkerTool(dependencies, name, input);
};

const callWorkerTool = (
  dependencies: PluginHostDependencies,
  name: string,
  input: unknown,
): Promise<unknown> =>
  withHost(
    dependencies,
    pluginCallMs(dependencies, TOOL_TIMEOUT_MS) + 5_000,
    `${dependencies.install.name}'s ${name} tool`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
        dependencies.currentHost,
      ).callTool(name, input, call, host),
  );

/** Runs one of the install's palette commands. */
export const runPluginCommand = (
  dependencies: PluginHostDependencies,
  id: string,
): Promise<unknown> =>
  withHost(
    dependencies,
    pluginCallMs(dependencies, COMMAND_TIMEOUT_MS) + 5_000,
    `${dependencies.install.name}'s ${id} command`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
        dependencies.currentHost,
      ).runCommand(id, call, host),
  );

// ─── Hosts ───
/** Runs a function the install's Worker code exposed, for another host. */
export const callPluginWorkerHost = (
  dependencies: PluginHostDependencies,
  fn: string,
  args: unknown,
  from: string,
): Promise<unknown> =>
  withHost(
    dependencies,
    pluginCallMs(dependencies, HOST_CALL_TIMEOUT_MS) + 5_000,
    `${dependencies.install.name}'s ${fn} function`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
        dependencies.currentHost,
      ).hostCall(fn, args, from, call, host),
  );

/**
 * Runs one of the install's exposed functions for another plugin's
 * `ctx.plugins.call`, within `ms` (what is left of the caller's own limit).
 */
export const callPluginExport = (
  dependencies: PluginHostDependencies,
  fn: string,
  args: unknown,
  ms: number,
): Promise<unknown> =>
  withHost(
    dependencies,
    ms,
    `${dependencies.install.name}'s ${fn} export`,
    (call, host) =>
      entrypoint(
        dependencies.bindings,
        dependencies.db,
        dependencies.install,
      ).callExport(fn, args, call, host, ms),
  );
