// Runs one plugin call in the plugin container (the `container` plugin host,
// apps/core/src/plugins/hosts/container/object.ts starts one runner process
// per call). It speaks newline-delimited JSON with that object:
//
//   stdin  line 1: { t: "invoke", nonce, entry, call, info }
//   stdout       : <nonce>{ t: "rpc", id, m, a }       a ctx call into dx
//   stdin        : { t: "ret", id, ok, v | e }         its answer
//   stdout       : <nonce>{ t: "done", ok, v | e }     the call's result
//
// Lines on stdout without the nonce (a child process writing there) are
// ignored by the object, and console output goes to stderr, so stray output
// is never read as protocol. Plugin code that reaches the nonce can still
// write lines; that is harmless, since every rpc is checked by dx's
// capability object exactly as a real one is. The first line after the
// invoke is { t: "pid" }: the object kills that process group when the call
// ends, so no child outlives it. The plugin's container module default-exports
// `(dx) => dx.expose({ fn(args, ctx) {...} })`, as in the Worker host.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let nonce = "";
let nextId = 1;
let started = false;

const write = (message) => {
  process.stdout.write(`${nonce}${JSON.stringify(message)}\n`);
};
const errorText = (error) =>
  error instanceof Error ? error.message : String(error);
const plain = (value) => {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
};

// Plugin console output is the plugin's log, not protocol.
for (const level of ["log", "info", "warn", "error", "debug"])
  console[level] = (...args) => {
    process.stderr.write(
      `${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}\n`,
    );
  };

const rpc = (method, ...args) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    write({
      t: "rpc",
      id,
      m: method,
      a: args.map((arg) => plain(arg) ?? null),
    });
  });

const finish = (message) => {
  write(message);
  // Let stdout drain, then end even if plugin code left timers behind.
  process.stdout.write("", () => process.exit(0));
};

/** The same ctx shape the Worker host builds (worker-host/runtime.ts). */
const contextOf = (info) => {
  const grants = info.grants ?? {};
  const log = (level) => (message, data) => {
    rpc("log", level, String(message), plain(data) ?? {}).catch(
      () => undefined,
    );
  };
  const ctx = {
    install: info.install,
    caller: info.caller,
    tier: info.tier,
    storage: Object.freeze({
      get: (key) => rpc("storageGet", String(key)),
      set: (key, value) => rpc("storageSet", String(key), plain(value) ?? null),
      delete: (key) => rpc("storageDelete", String(key)),
      list: (prefix) =>
        rpc("storageList", prefix === undefined ? "" : String(prefix)),
    }),
    settings: Object.freeze({ get: () => rpc("settings") }),
    log: Object.freeze({
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    }),
  };
  const threadAccess = (id) => {
    const target = id === info.threadId ? null : id;
    const access = {};
    if (grants.threadRead) {
      const details = () => rpc("threadInfo", target);
      access.info = details;
      access.title = Object.freeze({
        get: async () => (await details()).title,
      });
      access.state = Object.freeze({
        get: async () => (await details()).state,
      });
      access.messages = (options) =>
        rpc("threadMessages", target, plain(options) ?? {});
    }
    if (grants.threadPost) {
      const textOf = (message) => {
        if (typeof message === "string") return message;
        if (
          message !== null &&
          typeof message === "object" &&
          typeof message.content === "string"
        )
          return message.content;
        throw new TypeError(
          "A message is text, or { type: 'user-message', content }.",
        );
      };
      access.appendUserMessage = async (message) => {
        await rpc("threadPost", target, textOf(message), false);
      };
      access.note = async (text) => {
        await rpc("threadPost", target, textOf(text), true);
      };
    }
    return access;
  };
  if (info.threadId !== undefined)
    ctx.thread = Object.freeze({
      id: info.threadId,
      ...threadAccess(info.threadId),
    });
  if (grants.threads || grants.threadRead || grants.threadPost)
    ctx.threads = Object.freeze({
      ...(grants.threads
        ? { create: (options) => rpc("createThread", plain(options) ?? {}) }
        : {}),
      ...(grants.threadRead || grants.threadPost
        ? {
            get(id) {
              if (
                typeof id !== "string" ||
                !/^thr_[A-Za-z0-9_-]{1,64}$/.test(id)
              )
                throw new Error("ctx.threads.get takes a Thread id, thr_….");
              return Object.freeze({ id, ...threadAccess(id) });
            },
          }
        : {}),
    });
  if (grants.network)
    ctx.fetch = async (input, init = {}) => {
      const headers = {};
      for (const [name, value] of new Headers(init.headers ?? {}))
        headers[name] = value;
      const answer = await rpc("fetch", String(input), {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: String(init.body) }),
      });
      const empty =
        answer.status === 204 ||
        answer.status === 205 ||
        answer.status === 304 ||
        answer.body === "";
      return new Response(empty ? null : answer.body, {
        status: answer.status,
        headers: answer.headers,
      });
    };
  if (grants.secrets)
    ctx.secrets = Object.freeze({ get: (name) => rpc("secret", String(name)) });
  if (grants.ai)
    ctx.ai = Object.freeze({
      generate: (options) => rpc("generate", plain(options) ?? {}),
    });
  return Object.freeze(ctx);
};

const run = async ({ entry, call, info }) => {
  const exposed = new Map();
  let sealed = false;
  const api = Object.freeze({
    apiVersion: 1,
    expose(handlers) {
      if (sealed)
        throw new Error("Expose functions while the plugin starts, not later.");
      if (handlers === null || typeof handlers !== "object")
        throw new TypeError("expose takes an object of functions.");
      for (const [name, handler] of Object.entries(handlers)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name))
          throw new Error(`${name} is not a valid function name.`);
        if (typeof handler !== "function")
          throw new TypeError(`${name} must be a function.`);
        exposed.set(name, handler);
      }
    },
    // The other registrations belong to the Worker host; here they are no-ops
    // so one module can serve both hosts.
    on() {},
    registerTool() {},
    registerCommand() {},
    registerPane() {},
    registerLinkPattern() {},
  });
  const module = await import(pathToFileURL(entry).href);
  const setup = module.default;
  if (typeof setup !== "function")
    throw new Error(
      "The container module's default export must be a function that receives the plugin API.",
    );
  await setup(api);
  sealed = true;
  if (call.kind !== "host-call" && call.kind !== "export")
    throw new Error(
      `The container host runs exposed functions only, not ${call.kind} calls.`,
    );
  const handler = exposed.get(call.fn);
  if (handler === undefined)
    throw new Error(`The container module exposes no function ${call.fn}.`);
  return plain(await handler(call.args, contextOf(info))) ?? null;
};

lines.on("line", (line) => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.t === "invoke" && !started) {
    started = true;
    nonce = String(message.nonce);
    write({ t: "pid", pid: process.pid });
    run(message).then(
      (value) => finish({ t: "done", ok: true, v: value }),
      (error) => finish({ t: "done", ok: false, e: errorText(error) }),
    );
    return;
  }
  if (message.t === "ret") {
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.v);
    else waiting.reject(new Error(String(message.e)));
  }
});
lines.on("close", () => {
  for (const waiting of pending.values())
    waiting.reject(new Error("dx ended the call."));
  pending.clear();
});
