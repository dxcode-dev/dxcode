import type {
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { type CodeModule, searchTools } from "../catalog.js";

/** Tagged host errors (MCP admission, transport) carry a code, not a message. */
const hostErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== "") return error.message;
  const { _tag, code } = error as { _tag?: unknown; code?: unknown };
  const name = typeof _tag === "string" ? _tag : error.name;
  return typeof code === "string" ? `${name}: ${code}` : name;
};
export const CODE_LIMITS = {
  wallMs: 60_000,
  memoryBytes: 8 * 1024 * 1024,
  outputBytes: 128 * 1024,
  hostCalls: 64,
  sourceBytes: 128 * 1024,
  interruptChecks: 10_000,
} as const;
export type CodeHostCall = (
  module: CodeModule,
  functionName: string,
  input: Record<string, unknown>,
  raw: boolean,
  signal: AbortSignal,
) => Promise<unknown>;

const bootstrap = `
delete globalThis.console;
globalThis.text = value => __output(typeof value === 'string' ? value : '\u0060\u0060\u0060json\\n' + JSON.stringify(value, null, 2) + '\\n\u0060\u0060\u0060');
globalThis.content = value => {
  for (const block of Array.isArray(value) ? value : [value]) {
    if (block && block.type === 'text' && typeof block.text === 'string') __output(block.text);
    else if (block && block.type === 'image') __output('[Image: ' + block.mimeType + '; image attachments are not supported by this tool result.]');
  }
};
globalThis.shapeOf = value => {
  const seen = new Set();
  const shape = (v, depth) => {
    if (depth > 32) return { type: 'unknown' };
    if (v === null) return { type: 'null' };
    if (typeof v !== 'object') return { type: typeof v };
    if (seen.has(v)) return { type: 'circular' };
    seen.add(v);
    let result;
    if (Array.isArray(v)) {
      const items = [...new Map(v.map(item => { const s = shape(item, depth + 1); return [JSON.stringify(s), s]; })).values()];
      result = { type: 'array', items: items.length === 1 ? items[0] : { anyOf: items } };
    } else result = { type: 'object', properties: Object.fromEntries(Object.keys(v).sort().map(key => [key, shape(v[key], depth + 1)])) };
    seen.delete(v);
    return result;
  };
  return shape(value, 0);
};
globalThis.tool_search = query => __search(String(query));
globalThis.tool_describe = query => __search(String(query));
`;

/** Each run owns a fresh runtime, context, promises and interrupt deadline. */
export const executeCode = async (
  wasm: QuickJSWASMModule,
  modules: ReadonlyArray<CodeModule>,
  source: string,
  call: CodeHostCall,
  signal?: AbortSignal,
  limits: {
    wallMs: number;
    memoryBytes: number;
    outputBytes: number;
    hostCalls: number;
    sourceBytes: number;
    interruptChecks?: number;
  } = CODE_LIMITS,
): Promise<string> => {
  if (new TextEncoder().encode(source).length > limits.sourceBytes)
    throw new Error("Code source limit exceeded.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () =>
    controller.abort(signal?.reason ?? new Error("Code execution aborted."));
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + limits.wallMs;
  const timer = setTimeout(
    () => controller.abort(new Error("Code execution deadline exceeded.")),
    limits.wallMs,
  );
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  let interruptChecks = 0;
  // A deterministic CPU budget also works when workerd freezes its clock during JS.
  runtime.setInterruptHandler(
    () =>
      ++interruptChecks >
        (limits.interruptChecks ?? CODE_LIMITS.interruptChecks) ||
      controller.signal.aborted ||
      Date.now() >= deadline,
  );
  const vm = runtime.newContext();
  const deferreds: QuickJSDeferredPromise[] = [];
  const pending = new Set<Promise<void>>();
  const outputs: string[] = [];
  let outputBytes = 0;
  let hostCalls = 0;
  let disposed = false;
  let fatal: Error | undefined;
  let evaluation: QuickJSHandle | undefined;
  const check = () => {
    if (fatal) throw fatal;
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error("Code execution deadline exceeded.");
  };
  const bind = (name: string, fn: Parameters<typeof vm.newFunction>[1]) => {
    const handle = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  const guestValue = (value: unknown) =>
    vm.unwrapResult(
      vm.evalCode(
        `JSON.parse(${JSON.stringify(JSON.stringify(value ?? null))})`,
      ),
    );
  try {
    bind("__output", (value) => {
      const text = vm.getString(value);
      outputBytes += new TextEncoder().encode(text).length + 1;
      if (outputBytes > limits.outputBytes) {
        fatal = new Error("Code output limit exceeded.");
        throw fatal;
      }
      outputs.push(text);
      return vm.undefined;
    });
    bind("__search", (query) =>
      vm.newString(searchTools(modules, vm.getString(query))),
    );
    bind("__call", (moduleName, functionName, inputJson, rawValue) => {
      check();
      if (++hostCalls > limits.hostCalls) {
        fatal = new Error("Code host call limit exceeded.");
        throw fatal;
      }
      const module = modules.find(
        ({ name }) => name === vm.getString(moduleName),
      );
      const name = vm.getString(functionName);
      if (!module?.functions.some((fn) => fn.name === name))
        throw new Error("Unknown reviewed function.");
      const input = JSON.parse(vm.getString(inputJson)) as unknown;
      if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("Tool input must be an object.");
      const deferred = vm.newPromise();
      deferreds.push(deferred);
      const raw = vm.dump(rawValue) === true;
      const work = Promise.resolve()
        .then(() => {
          check();
          return call(
            module,
            name,
            input as Record<string, unknown>,
            raw,
            controller.signal,
          );
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
            const handle = vm.newError(hostErrorMessage(error));
            try {
              deferred.reject(handle);
            } finally {
              handle.dispose();
            }
          } catch {
            // An exhausted guest may not have enough memory to construct an error.
            fatal = error instanceof Error ? error : new Error(String(error));
          }
        })
        .finally(() => pending.delete(work));
      pending.add(work);
      return deferred.handle;
    });
    runtime.setModuleLoader((name) => {
      const module = modules.find((module) => module.name === name);
      if (!module) throw new Error(`Unknown module: ${name}`);
      return module.functions
        .map((fn, index) => {
          const args = `${JSON.stringify(name)}, ${JSON.stringify(fn.name)}, JSON.stringify(input, (_key, value) => typeof value === 'function' ? value.toString() : value)`;
          return `const f${index} = async (input = {}) => __call(${args}, false); f${index}.raw = async (input = {}) => __call(${args}, true); export { f${index} as ${JSON.stringify(fn.name)} };`;
        })
        .join("\n");
    });
    vm.unwrapResult(vm.evalCode(bootstrap)).dispose();
    evaluation = vm.unwrapResult(
      vm.evalCode(source, "code-exec.mjs", { type: "module" }),
    );
    while (true) {
      check();
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error) {
        const details = vm.dump(jobs.error);
        jobs.error.dispose();
        throw new Error(JSON.stringify(details));
      }
      const state = vm.getPromiseState(evaluation);
      if (state.type === "rejected") {
        const details = vm.dump(state.error);
        state.error.dispose();
        throw new Error(
          typeof details === "string" ? details : JSON.stringify(details),
        );
      }
      if (state.type === "fulfilled") {
        // Non-promises are reported fulfilled with the original handle.
        if (state.value !== evaluation) state.value.dispose();
        if (pending.size === 0 && !runtime.hasPendingJob()) break;
      }
      if (runtime.hasPendingJob()) continue;
      // Yield for host I/O and the watchdog, including never-settled guest promises.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    check();
    return outputs.join("\n");
  } finally {
    disposed = true;
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    evaluation?.dispose();
    for (const deferred of deferreds) deferred.dispose();
    vm.dispose();
    runtime.dispose();
  }
};
