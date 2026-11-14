import type {
  QuickJSDeferredPromise,
  QuickJSHandle,
} from "quickjs-emscripten-core";
import { getCodeWasm } from "../code/providers/wasm.js";
import type { PluginCallInfo, PluginHost } from "./host.js";
import { RUNTIME_MODULE } from "./runtime.js";

/**
 * The fallback host for deployments without the Dynamic Worker loader
 * (`LOADER`): each call runs dx's plugin runtime and the plugin's modules
 * in a fresh QuickJS runtime inside the Worker, with the same limits on
 * memory and time as the Code plugin. The plugin reaches dx only through
 * the call's {@link PluginHost}, exactly as it would from its own Dynamic
 * Worker; it has no network, bindings, or state between calls, so module
 * state (a value a handler keeps for later) does not survive here.
 */

export const QUICKJS_PLUGIN_LIMITS = {
  memoryBytes: 32 * 1024 * 1024,
  outputBytes: 1024 * 1024,
  hostCalls: 256,
} as const;

/** The PluginHost methods a plugin may call; nothing else is reachable. */
const HOST_METHODS = new Set([
  "log",
  "storageGet",
  "storageSet",
  "storageDelete",
  "storageList",
  "settings",
  "fetch",
  "secret",
  "callTool",
  "generate",
  "createThread",
  // Plugin agents: runs a child Thread and waits for its answer.
  "runAgent",
  "exec",
  // Plugin UI (M3); absent methods fail like any unknown one.
  "uiPrompt",
  "uiNotify",
  "createQuickAction",
  "removeQuickAction",
  // Plugin panes (M4b).
  "paneOpen",
  "panePost",
  // The state an archived Thread's pane or tab shows.
  "paneSnapshot",
  // Thread access: permissions.threads read and post.
  "threadInfo",
  "threadMessages",
  "threadPost",
  // Ctx.host(kind).call.
  "hostCall",
  // Another plugin's exports, through dx.
  "pluginCall",
  // Durable host.
  "sqlExec",
  "blobPut",
  "blobGet",
  "blobDelete",
  "blobList",
  "jobsSchedule",
  "jobsCancel",
  "jobsList",
  "watchOpen",
  "watchClose",
  "wake",
  // String messages only here; binary needs the Dynamic Worker.
  "streamOpen",
  "streamSend",
  "streamClose",
]);

/** What the plugin runtime needs that QuickJS lacks: a Workers shim. */
const SHIMS = `
// A plugin's console goes to dx's log, as from its Dynamic Worker.
globalThis.console = Object.freeze(Object.fromEntries(
  ["log", "info", "debug", "warn", "error"].map((level) => [level, (...values) =>
    __host("log", JSON.stringify([level === "warn" || level === "error" ? level : "info",
      values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "), {}])).catch(() => {})]),
));
// Timers wait on the host; a call ends once its result is in, so a timer
// still waiting then (such as a handler's own timeout) is dropped.
const timers = new Set();
let nextTimer = 0;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = ++nextTimer;
  timers.add(id);
  __sleep(Number(ms) || 0).then(() => {
    if (timers.delete(id)) fn(...args);
  });
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); };
class Headers {
  constructor(init) {
    this.map = new Map();
    const entries = init instanceof Headers ? [...init.map] : Array.isArray(init) ? init : Object.entries(init ?? {});
    for (const [name, value] of entries) this.map.set(String(name).toLowerCase(), String(value));
  }
  get(name) { return this.map.get(String(name).toLowerCase()) ?? null; }
  has(name) { return this.map.has(String(name).toLowerCase()); }
  set(name, value) { this.map.set(String(name).toLowerCase(), String(value)); }
  [Symbol.iterator]() { return this.map[Symbol.iterator](); }
  entries() { return this.map.entries(); }
}
class Response {
  constructor(body, init = {}) {
    this.body = body ?? null;
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers);
  }
  async text() { return this.body === null ? "" : String(this.body); }
  async json() { return JSON.parse(await this.text()); }
}
globalThis.Headers = Headers;
globalThis.Response = Response;
`;

const DRIVER = "dx-quickjs-driver.js";

/** Resolves a module request against the module that imports it. */
const resolve = (base: string, requested: string) => {
  if (!requested.startsWith("./") && !requested.startsWith("../"))
    return requested;
  const parts = base.split("/").slice(0, -1);
  for (const segment of requested.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
};

export type QuickJSPluginOperation =
  | { readonly kind: "describe" }
  | {
      readonly kind: "dispatch";
      readonly event: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "callTool";
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly kind: "runCommand"; readonly id: string }
  | {
      readonly kind: "paneMessage";
      readonly id: string;
      readonly message: unknown;
    }
  | {
      readonly kind: "hostCall";
      readonly fn: string;
      readonly args: unknown;
      readonly from: string;
    }
  | {
      readonly kind: "callExport";
      readonly fn: string;
      readonly args: unknown;
      readonly ms: number;
    }
  | {
      readonly kind: "runJob";
      readonly id: string;
      readonly runId: string;
      readonly data: unknown;
    }
  | {
      readonly kind: "watchMessage";
      readonly target: string;
      readonly message: unknown;
    };

/**
 * Runs one operation of a plugin in a fresh QuickJS runtime and returns
 * what the plugin runtime's method returned, as JSON.
 */
export const runPluginInQuickJS = async (input: {
  /** Every module of the plugin worker, by path, as the loader would get. */
  readonly modules: Readonly<Record<string, string>>;
  readonly operation: QuickJSPluginOperation;
  readonly call?: PluginCallInfo;
  readonly host?: PluginHost;
  readonly wallMs: number;
}): Promise<unknown> => {
  const wasm = await getCodeWasm();
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(QUICKJS_PLUGIN_LIMITS.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  // A prompt waiting on a person does not count against the wall limit,
  // as on a Dynamic Worker.
  let deadline = Date.now() + input.wallMs;
  let waitingOnPeople = 0;
  let waitingSince = 0;
  let stopped: Error | undefined;
  // workerd's clock stands still while JavaScript runs, so a loop is
  // stopped by a count of interrupt checks, as in the Code plugin.
  let interruptChecks = 0;
  // The Code plugin's rate: 10,000 checks for a 60-second run.
  const interruptBudget = Math.max(2_000, Math.round(input.wallMs / 6));
  runtime.setInterruptHandler(() => {
    if (Date.now() >= deadline || ++interruptChecks > interruptBudget)
      stopped ??= new Error(
        `The plugin call took longer than ${input.wallMs / 1_000} seconds.`,
      );
    return stopped !== undefined;
  });
  const vm = runtime.newContext();
  const deferreds: QuickJSDeferredPromise[] = [];
  const pending = new Set<Promise<void>>();
  let output: string | undefined;
  /** The driver delivered its result; waiting timers no longer matter. */
  let finished = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let hostCalls = 0;
  let disposed = false;
  let fatal: Error | undefined;
  let evaluation: QuickJSHandle | undefined;
  const bind = (name: string, fn: Parameters<typeof vm.newFunction>[1]) => {
    const handle = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  const guestValue = (value: unknown) =>
    vm.unwrapResult(
      vm.evalCode(
        value === undefined
          ? "undefined"
          : `JSON.parse(${JSON.stringify(JSON.stringify(value))})`,
      ),
    );
  const modules: Record<string, string> = {
    ...input.modules,
    "cloudflare:workers": "export class WorkerEntrypoint {}",
    // One call per QuickJS runtime, so its one store is that call's.
    "node:async_hooks":
      "export class AsyncLocalStorage { run(store, fn) { this.store = store; return fn(); } getStore() { return this.store; } }",
    [DRIVER]: `import Entrypoint from ${JSON.stringify(`./${RUNTIME_MODULE}`)};
const operation = JSON.parse(__operation);
const call = __call === "" ? undefined : JSON.parse(__call);
const host = new Proxy({}, {
  get: (_target, method) => (...args) => __host(String(method), JSON.stringify(args)),
});
const entry = new Entrypoint();
const result =
  operation.kind === "describe" ? await entry.describe()
  : operation.kind === "dispatch" ? await entry.dispatch(operation.event, operation.payload, call, host)
  : operation.kind === "runCommand" ? await entry.runCommand(operation.id, call, host)
  : operation.kind === "paneMessage" ? await entry.paneMessage(operation.id, operation.message, call, host)
  : operation.kind === "hostCall" ? await entry.hostCall(operation.fn, operation.args, operation.from, call, host)
  : operation.kind === "callExport" ? await entry.callExport(operation.fn, operation.args, call, host, operation.ms)
  : operation.kind === "runJob" ? await entry.runJob(operation.id, operation.runId, operation.data, call, host)
  : operation.kind === "watchMessage" ? await entry.watchMessage(operation.target, operation.message, call, host)
  : await entry.callTool(operation.name, operation.input, call, host);
__result(result === undefined ? "" : JSON.stringify(result));
`,
  };
  try {
    const setString = (name: string, value: string) => {
      const handle = vm.newString(value);
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    };
    setString("__operation", JSON.stringify(input.operation));
    setString(
      "__call",
      input.call === undefined ? "" : JSON.stringify(input.call),
    );

    bind("__sleep", (msValue) => {
      const ms = Math.max(0, Math.min(vm.getNumber(msValue), input.wallMs));
      const deferred = vm.newPromise();
      deferreds.push(deferred);
      const timer = setTimeout(() => {
        if (!disposed) deferred.resolve();
      }, ms);
      timers.push(timer);
      return deferred.handle;
    });
    bind("__result", (value) => {
      const text = vm.getString(value);
      if (
        new TextEncoder().encode(text).byteLength >
        QUICKJS_PLUGIN_LIMITS.outputBytes
      ) {
        fatal = new Error("The plugin's result is too large.");
        throw fatal;
      }
      output = text;
      finished = true;
      return vm.undefined;
    });
    bind("__host", (methodValue, argsValue) => {
      // Handles live only while this callback runs: read them now.
      const method = vm.getString(methodValue);
      const argsJson = vm.getString(argsValue);
      const host = input.host;
      const deferred = vm.newPromise();
      deferreds.push(deferred);
      const work = Promise.resolve()
        .then(() => {
          if (++hostCalls > QUICKJS_PLUGIN_LIMITS.hostCalls)
            throw new Error("The plugin called dx too many times in one call.");
          const target = host as unknown as Record<string, unknown> | undefined;
          const fn = target?.[method];
          // Arguments cross as JSON here, so a handler can't reach dx.
          if (method === "streamOnMessage")
            throw new Error(
              "A stream's onMessage needs the Dynamic Worker host; this fallback runtime can't hand dx a handler.",
            );
          if (!HOST_METHODS.has(method) || typeof fn !== "function")
            throw new Error(`dx has no ${method} for plugins here.`);
          const args = JSON.parse(argsJson) as unknown[];
          // A prompt or an agent's answer waits on others, not on the code.
          if (method !== "uiPrompt" && method !== "runAgent")
            return (fn as (...values: unknown[]) => unknown).apply(host, args);
          if (waitingOnPeople++ === 0) waitingSince = Date.now();
          return Promise.resolve(
            (fn as (...values: unknown[]) => unknown).apply(host, args),
          ).finally(() => {
            if (--waitingOnPeople === 0) deadline += Date.now() - waitingSince;
          });
        })
        .then((value) => {
          if (disposed) return;
          const handle = guestValue(value);
          try {
            deferred.resolve(handle);
          } finally {
            handle.dispose();
          }
        })
        .catch((error: unknown) => {
          if (disposed) return;
          try {
            const handle = vm.newError(
              error instanceof Error ? error.message : String(error),
            );
            try {
              deferred.reject(handle);
            } finally {
              handle.dispose();
            }
          } catch {
            fatal = error instanceof Error ? error : new Error(String(error));
          }
        })
        .finally(() => pending.delete(work));
      pending.add(work);
      return deferred.handle;
    });
    runtime.setModuleLoader(
      (name) => {
        const source = modules[name];
        if (source === undefined) throw new Error(`No module named ${name}.`);
        return source;
      },
      (base, requested) => resolve(base, requested),
    );
    vm.unwrapResult(vm.evalCode(SHIMS)).dispose();
    evaluation = vm.unwrapResult(
      vm.evalCode(
        `import ${JSON.stringify(`./${DRIVER}`)};`,
        "dx-quickjs-start.js",
        {
          type: "module",
        },
      ),
    );
    for (;;) {
      if (fatal) throw fatal;
      if (waitingOnPeople === 0 && Date.now() >= deadline)
        throw new Error(
          `The plugin call took longer than ${input.wallMs / 1_000} seconds.`,
        );
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error) {
        const details = vm.dump(jobs.error);
        jobs.error.dispose();
        throw new Error(
          typeof details === "object" &&
            details !== null &&
            "message" in details
            ? String((details as { message: unknown }).message)
            : JSON.stringify(details),
        );
      }
      const state = vm.getPromiseState(evaluation);
      if (state.type === "rejected") {
        const details = vm.dump(state.error);
        state.error.dispose();
        throw new Error(
          typeof details === "object" &&
            details !== null &&
            "message" in details
            ? String((details as { message: unknown }).message)
            : typeof details === "string"
              ? details
              : JSON.stringify(details),
        );
      }
      if (state.type === "fulfilled") {
        if (state.value !== evaluation) state.value.dispose();
        if (finished || (pending.size === 0 && !runtime.hasPendingJob())) break;
      }
      if (runtime.hasPendingJob()) continue;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    if (fatal) throw fatal;
    return output === undefined || output === ""
      ? undefined
      : JSON.parse(output);
  } catch (error) {
    throw stopped ?? error;
  } finally {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    evaluation?.dispose();
    for (const deferred of deferreds) deferred.dispose();
    vm.dispose();
    runtime.dispose();
  }
};
