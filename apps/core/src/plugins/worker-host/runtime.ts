/**
 * The main module of every plugin Dynamic Worker. dx writes it, not the
 * plugin: it imports the plugin's entry module, runs its default export
 * once per worker start with the plugin API, and serves four RPC methods:
 *
 * - `describe()`: the events the code handles, and the tools, palette
 *   commands, and link patterns it registered.
 * - `dispatch(event, payload, call, host)`: runs the event's handlers in
 *   registration order and returns their combined result.
 * - `callTool(name, input, call, host)`: runs a registered tool.
 * - `runCommand(id, call, host)`: runs a registered palette command.
 * - `callExport(fn, args, call, host, ms)`: runs a function `dx.expose`
 *   published, for another plugin's `ctx.plugins.call`.
 *
 * `call` says who the call runs for and what it may reach; `host` is an RPC
 * stub back into dx for those capabilities. The worker has no network
 * (`globalOutbound: null`), no bindings, and nothing kept between calls but
 * its own module state.
 */

export const RUNTIME_MODULE = "dx-plugin-runtime.js";
/** The module `import "@dxcode/plugin"` is pointed at. */
export const API_MODULE = "dxcode-plugin-api.js";

/**
 * Dynamic Workers resolve imports relative to the importing module, so a
 * bare `@dxcode/plugin` import is pointed at the API module by path.
 */
export const linkApiImports = (path: string, source: string) => {
  const depth = path.split("/").length - 1;
  const target = `${depth === 0 ? "./" : "../".repeat(depth)}${API_MODULE}`;
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])@dxcode\/plugin\2/g,
    (_match, prefix: string, quote: string) =>
      `${prefix}${quote}${target}${quote}`,
  );
};

/** Each event handler has this long; a hung handler is a failed one. */
export const HANDLER_TIMEOUT_MS = 10_000;
/** A webhook delivery's `trigger.received` handler has this long. */
export const TRIGGER_HANDLER_TIMEOUT_MS = 25_000;
/**
 * A schedule's run and a listener's message are the whole call, so their
 * handlers get the call's limit (`callMs`, `pluginCallLimitMs`).
 */
const CALL_LIMIT_EVENTS: ReadonlyArray<string> = ["job.run", "listener.event"];

/** How long one handler of `event` has, in a call that gets `callMs`. */
export const handlerTimeoutMs = (event: string, callMs: number | undefined) =>
  CALL_LIMIT_EVENTS.includes(event)
    ? (callMs ?? HANDLER_TIMEOUT_MS)
    : event === "trigger.received"
      ? TRIGGER_HANDLER_TIMEOUT_MS
      : HANDLER_TIMEOUT_MS;
/** Each registered tool call has this long. */
export const TOOL_TIMEOUT_MS = 60_000;
/** Each palette command has this long. */
export const COMMAND_TIMEOUT_MS = 60_000;
/** Each exposed function called from another host has this long. */
export const HOST_CALL_TIMEOUT_MS = 60_000;

/** What `import "@dxcode/plugin"` resolves to inside the worker. */
export const apiModuleSource = `export const PLUGIN_API_VERSION = 1;
export const MAX_AGENT_END_CONTINUATIONS = 5;
export const MAX_QUICK_ACTIONS_PER_THREAD = 5;
export const SHELL_DEFAULT_TIMEOUT_MS = 30000;
export const SHELL_MAX_TIMEOUT_MS = 60000;
export const SHELL_OUTPUT_BYTES = 131072;
export const MAX_THREAD_MESSAGES = 20;
export const MAX_THREAD_POSTS_PER_CALL = 5;
export const MAX_THREAD_POSTS_PER_MINUTE = 10;
export const MAX_PLUGIN_CALL_DEPTH = 3;
export const definePlugin = (entry) => entry;
`;

export const runtimeModuleSource = (entry: string) => `
import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import * as pluginModule from ${JSON.stringify(`./${entry}`)};

const EVENTS = new Set(["session.start", "agent.start", "agent.end", "tool.call", "tool.result", "trigger.received", "changes.prompt", "thread.archived", "thread.unarchived", "job.run", "listener.event"]);
// handlerTimeoutMs, in the worker.
const handlerMs = (event, callMs) =>
  ${JSON.stringify(CALL_LIMIT_EVENTS)}.includes(event) ? (callMs ?? ${HANDLER_TIMEOUT_MS})
  : event === "trigger.received" ? ${TRIGGER_HANDLER_TIMEOUT_MS}
  : ${HANDLER_TIMEOUT_MS};
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const COMMAND_ID = /^[a-z][a-z0-9-]{0,47}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,23}$/;
// The call each agent.run belongs to: the Thread it starts a child of.
const calls = new AsyncLocalStorage();
// Runs one call with its scope; before the call returns it waits for the
// ctx.log lines it sent, which go out without the plugin awaiting them, so
// a handler that logs and returns at once still has its lines logged.
const runCall = (scope, work) => {
  const logs = [];
  return calls.run({ ...scope, logs }, async () => {
    try {
      return await work();
    } finally {
      await Promise.allSettled(logs);
    }
  });
};
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const linkPatterns = [];
const agents = new WeakSet();
const agentModes = new Map();
// ─── Hosts ───
const exposed = new Map();
const EXPOSED_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
let sealed = false;
let setup;

// Each interpolated value in ctx.$ is one quoted shell word, an array one
// word per item. Only text passed through ctx.$.raw goes in as written:
// the runtime marks those itself, so no value from a model, a person, or a
// tool input can pass for one.
const rawShellText = new WeakSet();
const shellRaw = (text) => {
  const marked = Object.freeze({ text: String(text) });
  rawShellText.add(marked);
  return marked;
};
const shellWord = (value) => "'" + String(value).replace(/'/g, "'\\\\''") + "'";
const shellWords = (value) => {
  if (rawShellText.has(value)) return value.text;
  if (Array.isArray(value)) return value.map(shellWord).join(" ");
  if (value !== null && typeof value === "object") return shellWord(JSON.stringify(value));
  return shellWord(value);
};

const api = Object.freeze({
  apiVersion: 1,
  on(event, handler) {
    if (sealed) throw new Error("Register handlers while the plugin starts, not later.");
    if (!EVENTS.has(event)) throw new Error("dx has no event named " + String(event) + ".");
    if (typeof handler !== "function") throw new TypeError("An event handler must be a function.");
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool) {
    if (sealed) throw new Error("Register tools while the plugin starts, not later.");
    if (tool === null || typeof tool !== "object") throw new TypeError("registerTool takes a tool object.");
    if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name))
      throw new Error("A tool name is 1 to 48 lowercase letters, digits, and underscores, starting with a letter.");
    if (typeof tool.description !== "string" || tool.description.trim() === "")
      throw new Error("The tool " + tool.name + " needs a description.");
    if (typeof tool.execute !== "function") throw new TypeError("The tool " + tool.name + " needs an execute function.");
    if (tools.has(tool.name)) throw new Error("Two tools are named " + tool.name + ".");
    tools.set(tool.name, tool);
  },
  registerCommand(command) {
    if (sealed) throw new Error("Register commands while the plugin starts, not later.");
    if (command === null || typeof command !== "object") throw new TypeError("registerCommand takes a command object.");
    if (typeof command.id !== "string" || !COMMAND_ID.test(command.id))
      throw new Error("A command id is 1 to 48 lowercase letters, digits, and hyphens, starting with a letter.");
    if (typeof command.title !== "string" || command.title.trim() === "" || command.title.length > 80)
      throw new Error("The command " + command.id + " needs a title of at most 80 characters.");
    if (command.description !== undefined && (typeof command.description !== "string" || command.description.length > 200))
      throw new Error("The command " + command.id + "'s description is at most 200 characters.");
    if (typeof command.run !== "function") throw new TypeError("The command " + command.id + " needs a run function.");
    if (commands.has(command.id)) throw new Error("Two commands have the id " + command.id + ".");
    if (commands.size >= 16) throw new Error("A plugin registers at most 16 commands.");
    commands.set(command.id, command);
  },
  registerLinkPattern(link) {
    if (sealed) throw new Error("Register link patterns while the plugin starts, not later.");
    if (link === null || typeof link !== "object") throw new TypeError("registerLinkPattern takes a link pattern object.");
    const source = link.pattern instanceof RegExp ? link.pattern.source : link.pattern;
    const flags = (link.pattern instanceof RegExp ? link.pattern.flags : link.flags ?? "").replace(/[gy]/g, "");
    if (typeof source !== "string" || source === "" || source.length > 200)
      throw new Error("A link pattern is a regular expression of at most 200 characters.");
    if (!/^[imsu]*$/.test(flags)) throw new Error("A link pattern's flags are i, m, s, or u.");
    new RegExp(source, flags);
    if (typeof link.url !== "string" || !link.url.startsWith("https://") || link.url.length > 500)
      throw new Error("A link pattern's url is an https:// template of at most 500 characters, with $0 to $9 for the match's groups.");
    if (link.title !== undefined && (typeof link.title !== "string" || link.title.length > 120))
      throw new Error("A link pattern's title is at most 120 characters.");
    if (linkPatterns.length >= 16) throw new Error("A plugin registers at most 16 link patterns.");
    linkPatterns.push({ pattern: source, ...(flags === "" ? {} : { flags }), url: link.url, ...(link.title === undefined ? {} : { title: link.title }) });
  },
  createAgent(config) {
    if (sealed) throw new Error("Create agents while the plugin starts, not later.");
    if (config === null || typeof config !== "object") throw new TypeError("createAgent takes an agent config object.");
    if (typeof config.name !== "string" || !AGENT_NAME.test(config.name))
      throw new Error("An agent's name is 1 to 24 lowercase letters, digits, and hyphens, starting with a letter.");
    if (typeof config.instructions !== "string" || config.instructions.trim() === "")
      throw new Error("The agent " + config.name + " needs instructions.");
    // dx checks the rest (model grants, tools, display) when it runs.
    const definition = Object.freeze({ ...plain(config), kind: "agent-definition" });
    agents.add(definition);
    return Object.freeze({
      definition,
      run(message, options) {
        const scope = calls.getStore();
        if (scope === undefined)
          return Promise.reject(new Error("agent.run runs inside a plugin call: a tool, command, or event handler."));
        if (scope.call.threadId === undefined)
          return Promise.reject(new Error("agent.run runs only inside a Thread."));
        // dx checks the grant itself, so a refused run is audited too.
        return scope.time.waitOnPerson(() =>
          scope.host.runAgent(definition, String(message), plain(options) ?? {}));
      },
    });
  },
  registerAgentMode(mode) {
    if (sealed) throw new Error("Register agent modes while the plugin starts, not later.");
    if (mode === null || typeof mode !== "object") throw new TypeError("registerAgentMode takes { key, agent }.");
    if (typeof mode.key !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(mode.key))
      throw new Error("An agent mode's key is 1 to 24 lowercase letters, digits, and hyphens, starting with a letter.");
    if (!agents.has(mode.agent))
      throw new Error("The agent mode " + mode.key + " needs an agent definition from dx.createAgent.");
    if (agentModes.has(mode.key)) throw new Error("Two agent modes have the key " + mode.key + ".");
    agentModes.set(mode.key, mode.agent);
  },
  // ─── Hosts ───
  expose(functions) {
    if (sealed) throw new Error("Expose functions while the plugin starts, not later.");
    if (functions === null || typeof functions !== "object") throw new TypeError("expose takes an object of functions.");
    for (const [name, fn] of Object.entries(functions)) {
      if (!EXPOSED_NAME.test(name)) throw new Error("An exposed function's name is a JavaScript identifier of at most 64 characters.");
      if (typeof fn !== "function") throw new TypeError("expose: " + name + " is not a function.");
      if (exposed.has(name)) throw new Error("Two exposed functions are named " + name + ".");
      exposed.set(name, fn);
    }
  },
});

const ready = () => {
  setup ??= (async () => {
    const entry = pluginModule.default;
    if (typeof entry !== "function")
      throw new Error("The entry module's default export must be a function that receives the plugin API.");
    await entry(api);
    sealed = true;
  })();
  return setup;
};

/** JSON values only cross back into dx. */
const plain = (value) => {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
};

/**
 * One call's clock: its time limits stop while a prompt waits on a person,
 * and start again with the time they had left.
 */
const clock = () => {
  const limits = new Set();
  let waiting = 0;
  return {
    // The least time any running limit has left; what a plugin call may spend.
    remainingMs() {
      let least = Infinity;
      for (const limit of limits) least = Math.min(least, limit.left());
      return Number.isFinite(least) ? least : undefined;
    },
    within(ms, what, promise) {
      return new Promise((resolve, reject) => {
        let remaining = ms;
        let started = 0;
        let timer;
        const limit = {
          start() {
            started = Date.now();
            timer = setTimeout(() => reject(new Error(what + " took longer than " + ms / 1000 + " seconds.")), remaining);
          },
          stop() {
            clearTimeout(timer);
            remaining -= Date.now() - started;
          },
          left() {
            return waiting > 0 ? remaining : remaining - (Date.now() - started);
          },
        };
        limits.add(limit);
        if (waiting === 0) limit.start();
        const done = () => { limits.delete(limit); clearTimeout(timer); };
        Promise.resolve(promise).then(
          (value) => { done(); resolve(value); },
          (error) => { done(); reject(error); },
        );
      });
    },
    async waitOnPerson(run) {
      if (waiting++ === 0) for (const limit of limits) limit.stop();
      try {
        return await run();
      } finally {
        if (--waiting === 0) for (const limit of limits) limit.start();
      }
    },
  };
};

const context = (call, host, time) => {
  const log = (level) => (message, data) => {
    const sent = host.log(level, String(message), plain(data) ?? {}).catch(() => undefined);
    calls.getStore()?.logs?.push(sent);
  };
  const ctx = {
    install: call.install,
    caller: call.caller,
    storage: Object.freeze({
      get: (key) => host.storageGet(String(key)),
      set: (key, value) => host.storageSet(String(key), plain(value) ?? null),
      delete: (key) => host.storageDelete(String(key)),
      list: (prefix) => host.storageList(prefix === undefined ? "" : String(prefix)),
    }),
    settings: Object.freeze({ get: () => host.settings() }),
    log: Object.freeze({ info: log("info"), warn: log("warn"), error: log("error") }),
  };
  // A Thread's read and post methods, for the calling Thread and for
  // ctx.threads.get(id); dx checks reach and grants on every request.
  const threadAccess = (id) => {
    const target = id === call.threadId ? undefined : id;
    const access = {};
    if (call.grants.threadRead) {
      const info = () => host.threadInfo(target);
      access.info = info;
      access.title = Object.freeze({ get: async () => (await info()).title });
      access.state = Object.freeze({ get: async () => (await info()).state });
      access.messages = (options) => host.threadMessages(target, plain(options) ?? {});
    }
    if (call.grants.threadPost) {
      const textOf = (message) => {
        if (typeof message === "string") return message;
        if (message !== null && typeof message === "object" && typeof message.content === "string") return message.content;
        throw new TypeError("A message is text, or { type: 'user-message', content }.");
      };
      access.appendUserMessage = async (message) => { await host.threadPost(target, textOf(message), false); };
      access.append = async (messages) => {
        if (!Array.isArray(messages)) throw new TypeError("append takes a list of messages.");
        for (const message of messages) await host.threadPost(target, textOf(message), false);
      };
      access.note = async (text) => { await host.threadPost(target, textOf(text), true); };
    }
    return access;
  };
  // A webhook trigger runs before any Thread exists.
  if (call.threadId !== undefined)
    ctx.thread = Object.freeze({
      id: call.threadId,
      ...threadAccess(call.threadId),
      ...(call.grants.quickActions
        ? {
            createQuickAction: async (action) => ({ id: await host.createQuickAction(plain(action) ?? {}) }),
            removeQuickAction: (id) => host.removeQuickAction(String(id)),
          }
        : {}),
    });
  if (call.grants.threads || call.grants.threadRead || call.grants.threadPost || call.grants.threadOpen || call.grants.threadPostOwn)
    ctx.threads = Object.freeze({
      ...(call.grants.threads ? { create: (options) => host.createThread(plain(options) ?? {}) } : {}),
      // Install actions, the same calls a service makes (POST /threads).
      ...(call.grants.threadOpen ? { open: (options) => host.threadsOpen(plain(options) ?? {}) } : {}),
      ...(call.grants.threadPostOwn
        ? { post: async (id, text, options) => { await host.threadsPostOwn(String(id), String(text), (plain(options) ?? {}).wake === true); } }
        : {}),
      ...(call.grants.threadRead || call.grants.threadPost
        ? {
            get(id) {
              if (typeof id !== "string" || !/^thr_[A-Za-z0-9_-]{1,64}$/.test(id))
                throw new Error("ctx.threads.get takes a Thread id, thr_….");
              return Object.freeze({ id, ...threadAccess(id) });
            },
          }
        : {}),
    });
  if (call.grants.network) {
    ctx.fetch = async (input, init = {}) => {
      const headers = {};
      for (const [name, value] of new Headers(init.headers ?? {})) headers[name] = value;
      const answer = await host.fetch(String(input), {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: String(init.body) }),
      });
      const empty = answer.status === 204 || answer.status === 205 || answer.status === 304 || answer.body === "";
      return new Response(empty ? null : answer.body, { status: answer.status, headers: answer.headers });
    };
  }
  // Views described as data: one call sets state at a path, and open
  // browsers redraw. Each set returns the state's new version.
  if (call.grants.viewState)
    ctx.views = Object.freeze({
      set: (viewId, path, value) => host.viewSet(String(viewId), path === undefined ? "" : String(path), plain(value)),
      get: (viewId, path) => host.viewGet(String(viewId), path === undefined ? "" : String(path)),
      // A tool's result that names a view shows it as a card under the call.
      card: (viewId) => ({ _meta: { "dev.dxcode/view": String(viewId) } }),
    });
  if (call.grants.secrets) ctx.secrets = Object.freeze({ get: (name) => host.secret(String(name)) });
  if (call.grants.tools) ctx.tools = Object.freeze({ call: (name, input) => host.callTool(String(name), plain(input) ?? {}) });
  if (call.grants.ai) ctx.ai = Object.freeze({ generate: (options) => host.generate(plain(options) ?? {}) });
  if (call.grants.shell) {
    const run = (command, options = {}) => {
      const settings = plain(options) ?? {};
      return host.exec({ command: String(command), ...(settings.cwd === undefined ? {} : { cwd: settings.cwd }), ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }) });
    };
    const shell = (options) => {
      const tagged = (strings, ...values) => {
        if (!Array.isArray(strings) || !Array.isArray(strings.raw)) throw new TypeError("ctx.$ is a tagged template: ctx.$\`git status\`.");
        let command = strings[0];
        values.forEach((value, index) => { command += shellWords(value) + strings[index + 1]; });
        return run(command, options);
      };
      tagged.with = (more) => shell({ ...options, ...(plain(more) ?? {}) });
      tagged.raw = shellRaw;
      return Object.freeze(tagged);
    };
    ctx.$ = shell({});
    ctx.exec = run;
  }
  // ─── Hosts ───
  // Present when the manifest names entries per host; dx checks the kind
  // against the manifest and logs the call either way.
  if (Array.isArray(call.hosts)) {
    ctx.host = (kind) => Object.freeze({
      // The other host keeps its own limit, so this call's clock pauses.
      call: (fn, args) => time.waitOnPerson(() => host.hostCall(String(kind), String(fn), plain(args) ?? null)),
    });
  }
  // The install's cloud identity (POST /id-token for a service).
  if (call.grants.identity)
    ctx.identity = Object.freeze({
      token: (audience, ttlSeconds) => host.identityToken(String(audience), ttlSeconds === undefined ? undefined : Number(ttlSeconds)),
    });
  if (call.grants.plugins) {
    ctx.plugins = Object.freeze({
      // dx checks the grant and both installs, and audits it.
      call: (plugin, fn, args) => host.pluginCall(String(plugin), String(fn), plain(args) ?? null, time.remainingMs()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const refused = /^\\[(not-permitted|not-installed|not-exported|cycle)\\] /.exec(message);
        if (refused === null) throw error;
        const wrapped = new Error(message);
        wrapped.name = "PluginCallRefused";
        wrapped.code = refused[1];
        throw wrapped;
      }),
    });
  }
  if (call.calledBy !== undefined) ctx.calledBy = Object.freeze({ plugin: call.calledBy });
  if (call.grants.prompt || call.grants.notify) {
    const notGranted = (what) => () => Promise.reject(new Error("This plugin was not granted the " + what + " UI permission."));
    const ask = (kind) => (options) => time.waitOnPerson(() => host.uiPrompt(kind, plain(options) ?? {}));
    ctx.ui = Object.freeze({
      confirm: call.grants.prompt ? ask("confirm") : notGranted("prompt"),
      input: call.grants.prompt ? ask("input") : notGranted("prompt"),
      select: call.grants.prompt ? ask("select") : notGranted("prompt"),
      notify: call.grants.notify
        ? (message, options) => host.uiNotify(String(message), plain(options)?.level ?? "info")
        : notGranted("notify"),
    });
  }
  return Object.freeze(ctx);
};

/** An item's icon as written: lucide:<name> or a path under assets/; dx resolves it. */
const iconOf = (item) =>
  typeof item.icon === "string" && item.icon.length > 0 && item.icon.length <= 256 ? { icon: item.icon } : {};

const isAllow = (result) => result === undefined || result === null || result.action === "allow";

export default class extends WorkerEntrypoint {
  async describe() {
    await ready();
    return {
      events: [...handlers.keys()],
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description.trim().slice(0, 2048),
        inputSchema: plain(tool.inputSchema) ?? { type: "object", properties: {} },
        ...iconOf(tool),
      })),
      commands: [...commands.values()].map((command) => ({
        id: command.id,
        title: command.title.trim(),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...iconOf(command),
      })),
      linkPatterns,
      // Exports are the exposed names the manifest lists.
      exports: [...exposed.keys()],
      agentModes: [...agentModes].map(([key, agent]) => ({ key, agent: plain(agent) })),
      exposed: [...exposed.keys()],
    };
  }

  async dispatch(event, payload, call, host) {
    await ready();
    const time = clock();
    return runCall({ call, host, time }, () => this.#dispatchIn(time, event, payload, call, host));
  }

  async #dispatchIn(time, event, payload, call, host) {
    const ctx = context(call, host, time);
    const ms = handlerMs(event, call.callMs);
    const run = (handler, data) =>
      time.within(ms, "The " + event + " handler", Promise.resolve().then(() => handler(data, ctx))).then(plain);
    const list = handlers.get(event) ?? [];
    if (event === "tool.call") {
      // A modify hands its input to the next handler; the first other
      // answer that does not allow the call decides it.
      let current = payload;
      let modified = false;
      for (const handler of list) {
        const result = await run(handler, current);
        if (isAllow(result)) continue;
        if (result !== null && typeof result === "object" && result.action === "modify" && result.input !== null && typeof result.input === "object") {
          current = { ...current, input: result.input };
          modified = true;
          continue;
        }
        return result === undefined ? null : result;
      }
      return modified ? { action: "modify", input: current.input } : undefined;
    }
    if (event === "tool.result") {
      let current = payload;
      let modified = false;
      for (const handler of list) {
        const result = await run(handler, current);
        if (result !== undefined && result !== null && result.action === "modify") {
          current = { ...current, output: result.output };
          modified = true;
        }
      }
      return modified ? { action: "modify", output: current.output } : undefined;
    }
    if (event === "agent.start") {
      const notes = [];
      for (const handler of list) {
        const result = await run(handler, payload);
        if (result !== undefined && result !== null && typeof result.context === "string" && result.context.trim() !== "")
          notes.push(result.context);
      }
      return notes.length === 0 ? undefined : { context: notes.join("\\n\\n") };
    }
    if (event === "changes.prompt") {
      // Each handler sees the prompt the one before it returned.
      let current = payload;
      let changed = false;
      for (const handler of list) {
        const result = await run(handler, current);
        if (result !== undefined && result !== null && typeof result.prompt === "string" && result.prompt.trim() !== "") {
          current = { ...current, prompt: result.prompt };
          changed = true;
        }
      }
      return changed ? { prompt: current.prompt } : undefined;
    }
    if (event === "agent.end") {
      for (const handler of list) {
        const result = await run(handler, payload);
        if (result !== undefined && result !== null && result.action === "continue") return result;
      }
      return undefined;
    }
    for (const handler of list) await run(handler, payload);
    return undefined;
  }

  async callTool(name, input, call, host) {
    await ready();
    const tool = tools.get(name);
    if (tool === undefined) throw new Error("The plugin has no tool named " + name + ".");
    const time = clock();
    const output = await runCall({ call, host, time }, () => time.within(call.callMs ?? ${TOOL_TIMEOUT_MS}, "The tool " + name, Promise.resolve().then(() => tool.execute(input, context(call, host, time)))));
    return typeof output === "string" ? output : plain(output) ?? null;
  }

  async runCommand(id, call, host) {
    await ready();
    const command = commands.get(id);
    if (command === undefined) throw new Error("The plugin has no command " + id + ".");
    const time = clock();
    await runCall({ call, host, time }, () => time.within(call.callMs ?? ${COMMAND_TIMEOUT_MS}, "The command " + id, Promise.resolve().then(() => command.run(context(call, host, time)))));
    return null;
  }

  // ─── Hosts ───
  async hostCall(fn, args, from, call, host) {
    await ready();
    const target = exposed.get(fn);
    if (target === undefined) throw new Error("The plugin exposes no function named " + fn + ".");
    const time = clock();
    const result = await runCall({ call, host, time }, () => time.within(call.callMs ?? ${HOST_CALL_TIMEOUT_MS}, "The exposed function " + fn, Promise.resolve().then(() => target(args, context(call, host, time)))));
    return plain(result) ?? null;
  }

  async callExport(fn, args, call, host, ms) {
    await ready();
    const handler = exposed.get(fn);
    if (handler === undefined) throw new Error("The plugin exposes no function " + fn + ".");
    const time = clock();
    const result = await runCall({ call, host, time }, () => time.within(Math.min(ms, ${TOOL_TIMEOUT_MS}), "The export " + fn, Promise.resolve().then(() => handler(args, context(call, host, time)))));
    return plain(result) ?? null;
  }
}
`;
