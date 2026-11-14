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
 * - `paneMessage(id, message, call, host)`: runs a registered pane's or
 *   view's `onMessage` for a message its view sent.
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
/** Each registered tool call has this long. */
export const TOOL_TIMEOUT_MS = 60_000;
/** Each palette command has this long. */
export const COMMAND_TIMEOUT_MS = 60_000;
/** Each pane's `onMessage` has this long. */
export const PANE_MESSAGE_TIMEOUT_MS = 60_000;
/** Each exposed function called from another host has this long. */
export const HOST_CALL_TIMEOUT_MS = 60_000;
/** Each job run has this long (a trusted tier's call limit). */
export const JOB_TIMEOUT_MS = 300_000;
/** Each `ctx.watch` handler has this long per message. */
export const WATCH_MESSAGE_TIMEOUT_MS = 60_000;

/** What `import "@dxcode/plugin"` resolves to inside the worker. */
export const apiModuleSource = `export const PLUGIN_API_VERSION = 1;
export const PLUGIN_TIERS = Object.freeze(["sandboxed", "personal-dev", "workspace-trusted", "verified"]);
export const MAX_AGENT_END_CONTINUATIONS = 5;
export const MAX_QUICK_ACTIONS_PER_THREAD = 5;
export const MAX_PANES_PER_PLUGIN = 4;
export const PANE_MESSAGES_KEPT = 20;
export const SHELL_DEFAULT_TIMEOUT_MS = 30000;
export const SHELL_MAX_TIMEOUT_MS = 60000;
export const SHELL_OUTPUT_BYTES = 131072;
export const MAX_THREAD_MESSAGES = 20;
export const MAX_THREAD_POSTS_PER_CALL = 5;
export const MAX_THREAD_POSTS_PER_MINUTE = 10;
export const MAX_VIEWS_PER_PLUGIN = 8;
export const MAX_PLUGIN_CALL_DEPTH = 3;
export const definePlugin = (entry) => entry;
`;

export const runtimeModuleSource = (entry: string) => `
import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import * as pluginModule from ${JSON.stringify(`./${entry}`)};

const EVENTS = new Set(["session.start", "agent.start", "agent.end", "tool.call", "tool.result", "trigger.received", "changes.prompt", "thread.archived", "thread.unarchived", "job.run"]);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const COMMAND_ID = /^[a-z][a-z0-9-]{0,47}$/;
const PANE_HTML_BYTES = 262144;
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
// UTF-8 length without TextEncoder, which the QuickJS host lacks.
const utf8Bytes = (text) => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
};
const handlers = new Map();
const panes = new Map();
// Tabs, pages, and Thread types draw views; other plugins call exports.
const views = new Map();
const tools = new Map();
const commands = new Map();
const linkPatterns = [];
const agents = new WeakSet();
const agentModes = new Map();
// ─── Hosts ───
const exposed = new Map();
const EXPOSED_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
// ─── Durable host ───
const jobs = new Map();
// ctx.watch handlers by target, in this isolate; dx re-runs the job or
// function that opened a watch when a message finds no handler here.
const watchHandlers = new Map();
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
  registerPane(pane) {
    if (sealed) throw new Error("Register panes while the plugin starts, not later.");
    if (pane === null || typeof pane !== "object") throw new TypeError("registerPane takes a pane object.");
    if (typeof pane.id !== "string" || !COMMAND_ID.test(pane.id))
      throw new Error("A pane id is 1 to 48 lowercase letters, digits, and hyphens, starting with a letter.");
    if (typeof pane.title !== "string" || pane.title.trim() === "" || pane.title.trim().length > 40)
      throw new Error("The pane " + pane.id + " needs a title of at most 40 characters.");
    if (typeof pane.html !== "string" || pane.html.trim() === "" || utf8Bytes(pane.html) > PANE_HTML_BYTES)
      throw new Error("The pane " + pane.id + " needs html of at most 256 KB.");
    if (pane.onMessage !== undefined && typeof pane.onMessage !== "function")
      throw new TypeError("The pane " + pane.id + "'s onMessage must be a function.");
    if (panes.has(pane.id) || views.has(pane.id)) throw new Error("Two panes or views have the id " + pane.id + ".");
    if (panes.size >= 4) throw new Error("A plugin registers at most 4 panes.");
    panes.set(pane.id, pane);
  },
  registerView(view) {
    if (sealed) throw new Error("Register views while the plugin starts, not later.");
    if (view === null || typeof view !== "object") throw new TypeError("registerView takes a view object.");
    if (typeof view.id !== "string" || !COMMAND_ID.test(view.id))
      throw new Error("A view id is 1 to 48 lowercase letters, digits, and hyphens, starting with a letter.");
    if (typeof view.html !== "string" || view.html.trim() === "" || utf8Bytes(view.html) > PANE_HTML_BYTES)
      throw new Error("The view " + view.id + " needs html of at most 256 KB.");
    if (view.onMessage !== undefined && typeof view.onMessage !== "function")
      throw new TypeError("The view " + view.id + "'s onMessage must be a function.");
    if (views.has(view.id) || panes.has(view.id)) throw new Error("Two panes or views have the id " + view.id + ".");
    if (views.size >= 8) throw new Error("A plugin registers at most 8 views.");
    views.set(view.id, view);
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
          return Promise.reject(new Error("agent.run runs inside a plugin call: a tool, command, event handler, or pane message."));
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
  // ─── Durable host ───
  registerJob(job) {
    if (sealed) throw new Error("Register jobs while the plugin starts, not later.");
    if (job === null || typeof job !== "object") throw new TypeError("registerJob takes { id, run }.");
    if (typeof job.id !== "string" || !COMMAND_ID.test(job.id))
      throw new Error("A job id is 1 to 48 lowercase letters, digits, and hyphens, starting with a letter.");
    if (typeof job.run !== "function") throw new TypeError("The job " + job.id + " needs a run function.");
    if (jobs.has(job.id)) throw new Error("Two jobs have the id " + job.id + ".");
    jobs.set(job.id, job);
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
    tier: call.tier ?? "sandboxed",
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
  if (call.grants.threads || call.grants.threadRead || call.grants.threadPost)
    ctx.threads = Object.freeze({
      ...(call.grants.threads ? { create: (options) => host.createThread(plain(options) ?? {}) } : {}),
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
  // against the install's tier and logs the call either way.
  if (Array.isArray(call.hosts)) {
    ctx.host = (kind) => Object.freeze({
      // The other host keeps its own limit, so this call's clock pauses.
      call: (fn, args) => time.waitOnPerson(() => host.hostCall(String(kind), String(fn), plain(args) ?? null)),
    });
  }
  // ─── Durable host ───
  if (call.grants.durable) {
    const bytesOf = (body) => {
      if (typeof body === "string") return body;
      if (body instanceof ArrayBuffer) return body;
      if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      throw new TypeError("A blob's body is text or an ArrayBuffer.");
    };
    ctx.sql = Object.freeze({
      exec: (sql, ...params) => host.sqlExec(String(sql), params.map((value) => value instanceof ArrayBuffer || value === null || typeof value !== "object" ? value : plain(value))),
    });
    ctx.blobs = Object.freeze({
      put: (key, body, meta) => host.blobPut(String(key), bytesOf(body), plain(meta) ?? {}),
      get: (key) => host.blobGet(String(key)),
      delete: (key) => host.blobDelete(String(key)),
      list: (prefix) => host.blobList(prefix === undefined ? "" : String(prefix)),
    });
    ctx.jobs = Object.freeze({
      schedule: (id, when, data) => host.jobsSchedule(String(id), plain(when) ?? {}, plain(data) ?? null),
      cancel: (id) => host.jobsCancel(String(id)),
      list: () => host.jobsList(),
    });
  }
  if (call.grants.wake) ctx.wake = (threadId, message) => host.wake(String(threadId), String(message));
  if (call.grants.watch) {
    ctx.watch = async (target, handler) => {
      if (typeof handler !== "function") throw new TypeError("ctx.watch takes a target and a handler function.");
      const key = String(target);
      watchHandlers.set(key, handler);
      try {
        await host.watchOpen(key);
      } catch (error) {
        watchHandlers.delete(key);
        throw error;
      }
      return Object.freeze({
        // Closed from a later call, the call's own host closes it.
        // Resolves once dx closed the connection; await it inside a call,
        // which ends (and with it the request) when the call returns.
        close: () => {
          watchHandlers.delete(key);
          return (calls.getStore()?.host ?? host).watchClose(key);
        },
      });
    };
  }
  if (call.grants.panes || call.grants.views) {
    const handles = new Map();
    ctx.panes = Object.freeze({
      get(id) {
        // A Thread tab is a view; it takes posts as a pane does.
        if (!(call.grants.panes && panes.has(id)) && !(call.grants.views && views.has(id)))
          throw new Error("The plugin registered no pane " + String(id) + ".");
        let handle = handles.get(id);
        if (handle === undefined) {
          handle = Object.freeze({
            id,
            open: () => host.paneOpen(id),
            post: (message) => host.panePost(id, plain(message) ?? null),
            // The state an archived Thread shows read-only ("show").
            snapshot: (state) => host.paneSnapshot(id, plain(state) ?? null),
          });
          handles.set(id, handle);
        }
        return handle;
      },
    });
  }
  if (call.grants.plugins) {
    ctx.plugins = Object.freeze({
      // dx checks the grant, both installs, and both tiers, and audits it.
      call: (plugin, fn, args) => host.pluginCall(String(plugin), String(fn), plain(args) ?? null, time.remainingMs()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const refused = /^\\[(not-permitted|not-installed|not-exported|lower-tier|owner-only|cycle)\\] /.exec(message);
        if (refused === null) throw error;
        const wrapped = new Error(message);
        wrapped.name = "PluginCallRefused";
        wrapped.code = refused[1];
        throw wrapped;
      }),
    });
  }
  if (call.calledBy !== undefined) ctx.calledBy = Object.freeze({ plugin: call.calledBy });
  if (call.grants.prompt || call.grants.notify || call.streams) {
    const notGranted = (what) => () => Promise.reject(new Error("This plugin was not granted the " + what + " UI permission."));
    const ask = (kind) => (options) => time.waitOnPerson(() => host.uiPrompt(kind, plain(options) ?? {}));
    // Ctx.ui.stream(paneId), only at a trusted tier.
    const stream = async (paneId) => {
      if (!panes.has(paneId)) throw new Error("The plugin registered no pane " + String(paneId) + ".");
      const opened = await host.streamOpen(paneId);
      const id = opened.id;
      return Object.freeze({
        id,
        url: opened.url,
        send: (chunk) => host.streamSend(id, chunk instanceof ArrayBuffer ? chunk : ArrayBuffer.isView(chunk) ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : String(chunk)),
        close: () => host.streamClose(id),
        onMessage: (handler) => { host.streamOnMessage(id, (data) => handler(data)).catch((error) => console.error("Stream onMessage is not available: " + String(error))); },
      });
    };
    ctx.ui = Object.freeze({
      confirm: call.grants.prompt ? ask("confirm") : notGranted("prompt"),
      input: call.grants.prompt ? ask("input") : notGranted("prompt"),
      select: call.grants.prompt ? ask("select") : notGranted("prompt"),
      notify: call.grants.notify
        ? (message, options) => host.uiNotify(String(message), plain(options)?.level ?? "info")
        : notGranted("notify"),
      ...(call.streams ? { stream } : {}),
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
      panes: [...panes.values()].map((pane) => ({
        id: pane.id,
        title: pane.title.trim(),
        html: pane.html,
        handlesMessages: pane.onMessage !== undefined,
        ...iconOf(pane),
      })),
      views: [...views.values()].map((view) => ({
        id: view.id,
        html: view.html,
        handlesMessages: view.onMessage !== undefined,
      })),
      // Exports are the exposed names the manifest lists.
      exports: [...exposed.keys()],
      agentModes: [...agentModes].map(([key, agent]) => ({ key, agent: plain(agent) })),
      exposed: [...exposed.keys()],
      jobs: [...jobs.keys()],
    };
  }

  async dispatch(event, payload, call, host) {
    await ready();
    const time = clock();
    return runCall({ call, host, time }, () => this.#dispatchIn(time, event, payload, call, host));
  }

  async #dispatchIn(time, event, payload, call, host) {
    const ctx = context(call, host, time);
    const run = (handler, data) =>
      time.within(${HANDLER_TIMEOUT_MS}, "The " + event + " handler", Promise.resolve().then(() => handler(data, ctx))).then(plain);
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

  // ─── Durable host ───
  async runJob(id, runId, data, call, host) {
    await ready();
    const base = String(id).split(":")[0];
    const job = jobs.get(base);
    const time = clock();
    if (job === undefined) {
      if (!handlers.has("job.run")) throw new Error("The plugin registered no job " + base + " and handles no job.run event.");
      await runCall({ call, host, time }, () => this.#dispatchIn(time, "job.run", { id, runId, data }, call, host));
      return null;
    }
    const result = await runCall({ call, host, time }, () => time.within(${JOB_TIMEOUT_MS}, "The job " + id, Promise.resolve().then(() => job.run(data, context(call, host, time)))));
    return plain(result) ?? null;
  }

  async watchMessage(target, message, call, host) {
    await ready();
    const handler = watchHandlers.get(target);
    if (handler === undefined) return { missing: true };
    const time = clock();
    await runCall({ call, host, time }, () => time.within(${WATCH_MESSAGE_TIMEOUT_MS}, "The watch handler for " + target, Promise.resolve().then(() => handler(message, context(call, host, time)))));
    return { missing: false };
  }

  async paneMessage(id, message, call, host) {
    await ready();
    // A tab's or page's view answers through the same call.
    const pane = panes.get(id) ?? views.get(id);
    if (pane === undefined) throw new Error("The plugin has no pane " + id + ".");
    if (pane.onMessage === undefined) throw new Error("The pane " + id + " takes no messages.");
    const time = clock();
    const result = await runCall({ call, host, time }, () => time.within(call.callMs ?? ${PANE_MESSAGE_TIMEOUT_MS}, "The pane " + id + "'s onMessage", Promise.resolve().then(() => pane.onMessage(message, context(call, host, time)))));
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
