import {
  apiModuleSource,
  runtimeModuleSource,
} from "../../worker-host/runtime.js";

/**
 * The Node program dxd runs for a plugin's Orb entry. It loads the very
 * runtime module the Worker host runs (so `dx.*` registration, `ctx.*`, the
 * per-call limits, and `dx.expose` behave the same), with three imports
 * mapped by a module loader:
 *
 * - `cloudflare:workers` → a stand-in `WorkerEntrypoint` base class;
 * - `@dxcode/plugin` → the API module the Worker host serves;
 * - the plugin's entry → `DX_PLUGIN_ENTRY`, in the plugin's own files.
 *
 * `main.mjs` speaks dxd's line protocol on fd 3 (see the dxd plugin-host
 * module): `call` lines run a runtime method with a host stand-in whose every
 * method is a `host` line that dxd relays to the calling Worker's
 * `PluginHost`, so the process reaches exactly what the Worker host would.
 * Bytes cross as `{ "$dxBytes": base64 }`.
 */

const loader = `// dx: maps the plugin runtime's imports for Node.
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
const entry = pathToFileURL(process.env.DX_PLUGIN_ENTRY ?? "").href;
const root = pathToFileURL((process.env.PLUGIN_ROOT ?? "") + "/").href;

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: new URL("workers.mjs", here).href, shortCircuit: true };
  if (specifier === "@dxcode/plugin") return { url: new URL("api.mjs", here).href, shortCircuit: true };
  if (specifier === "dx:plugin-entry") return { url: entry, shortCircuit: true };
  return next(specifier, context);
}

// A plugin's .js files are ES modules, as in the Worker host, whatever
// package.json says (or does not).
export async function load(url, context, next) {
  if (url.startsWith(root) && url.endsWith(".js")) return next(url, { ...context, format: "module" });
  return next(url, context);
}
`;

const workers = `// dx: what the plugin runtime extends in place of Cloudflare's class.
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`;

const main = `// dx: the Orb host's process. Protocol: one JSON object per line on fd 3.
import { register } from "node:module";
import net from "node:net";
import { spawn } from "node:child_process";

register("./loader.mjs", import.meta.url);

const BYTES = "$dxBytes";
const encode = (value) => {
  if (value instanceof ArrayBuffer) return { [BYTES]: Buffer.from(value).toString("base64") };
  if (ArrayBuffer.isView(value)) return { [BYTES]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = encode(item);
    return out;
  }
  return value;
};
const decode = (value) => {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    if (typeof value[BYTES] === "string" && Object.keys(value).length === 1) {
      const bytes = Buffer.from(value[BYTES], "base64");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = decode(item);
    return out;
  }
  return value;
};

const socket = new net.Socket({ fd: 3, readable: true, writable: true });
const send = (message) => socket.write(JSON.stringify(message) + "\\n");

// Capability calls this process is waiting on, by its own counter.
const waiting = new Map();
let nextCid = 1;
const ask = (id, method, args) =>
  new Promise((resolve, reject) => {
    const cid = nextCid++;
    waiting.set(cid, { resolve, reject });
    send({ t: "host", id, cid, method, args: encode(args) });
  });

// The streaming shell: ctx.$ runs here, in the Orb, once dx admits the
// command (permissions.shell, the Thread's tool.call plugins, an audit
// row). The promise resolves like the Worker host's ctx.$; it is also an
// async iterable of { stream, text } chunks as they arrive, with kill().
const SHELL_DEFAULT_MS = 60000;
const SHELL_MAX_MS = 300000;
const SHELL_KEPT_BYTES = 1048576;
const shell = (id, request) => {
  const chunks = [];
  const readers = [];
  let ended = false;
  let child;
  const push = (chunk) => {
    if (chunk) chunks.push(chunk);
    else ended = true;
    for (const wake of readers.splice(0)) wake();
  };
  const result = (async () => {
    const admitted = await ask(id, "shellAdmit", [request]);
    if (admitted.kind === "synthesize") {
      push({ stream: "stdout", text: admitted.output });
      push();
      return { exitCode: 0, stdout: admitted.output, stderr: "", timedOut: false, truncated: false };
    }
    const limit = Math.min(Math.max(Number(request.timeoutMs) || SHELL_DEFAULT_MS, 1000), SHELL_MAX_MS);
    const out = { stdout: "", stderr: "" };
    let truncated = false;
    let timedOut = false;
    child = spawn("bash", ["-c", admitted.command], { cwd: admitted.workdir, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, limit);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (text) => {
        push({ stream, text });
        if (out[stream].length < SHELL_KEPT_BYTES) out[stream] += text;
        else truncated = true;
      });
    }
    const exitCode = await new Promise((resolve) => child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1))));
    clearTimeout(timer);
    push();
    return { exitCode, stdout: out.stdout, stderr: out.stderr, timedOut, truncated };
  })();
  result.catch(() => push());
  result[Symbol.asyncIterator] = async function* () {
    let index = 0;
    for (;;) {
      if (index < chunks.length) { yield chunks[index++]; continue; }
      if (ended) return;
      await new Promise((wake) => readers.push(wake));
    }
  };
  result.kill = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
  return result;
};

const hostFor = (id) =>
  new Proxy(Object.freeze({}), {
    get(_target, method) {
      // Not a thenable: awaiting the host must not call it.
      if (typeof method !== "string" || method === "then") return undefined;
      if (method === "exec") return (request) => shell(id, request ?? {});
      return (...args) => ask(id, method, args);
    },
  });

const { default: Runtime } = await import("./runtime.mjs");
const runtime = new Runtime({}, {});
// Runs the plugin's default export once, as the Worker host's first call does.
await runtime.describe();
send({ t: "ready" });

const run = async (message) => {
  try {
    const method = runtime[message.method];
    if (typeof method !== "function") throw new Error("dx has no runtime method " + String(message.method) + ".");
    const args = decode(message.args ?? []);
    const value = message.method === "describe"
      ? await runtime.describe()
      : await method.call(runtime, ...args, message.info, hostFor(message.id));
    send({ t: "result", id: message.id, ok: true, value: encode(value ?? null) });
  } catch (error) {
    send({ t: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

let buffered = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.t === "call") void run(message);
    else if (message.t === "host-result") {
      const pending = waiting.get(message.cid);
      if (pending === undefined) continue;
      waiting.delete(message.cid);
      if (message.ok) pending.resolve(decode(message.value));
      else pending.reject(new Error(String(message.error)));
    }
  }
});
// dxd closed the channel: it stopped this process or is gone.
socket.on("close", () => process.exit(0));
`;

export interface OrbRuntimeFiles {
  readonly sha256: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
}

const cache = new Map<string, Promise<OrbRuntimeFiles>>();

/** The runtime for one entry path; cached per isolate, keyed by content. */
export const orbRuntimeFiles = (entry: string): Promise<OrbRuntimeFiles> => {
  let files = cache.get(entry);
  if (files === undefined) {
    files = (async () => {
      const runtime = runtimeModuleSource(entry).replace(
        `from ${JSON.stringify(`./${entry}`)}`,
        `from "dx:plugin-entry"`,
      );
      const list = [
        { path: "main.mjs", content: main },
        { path: "loader.mjs", content: loader },
        { path: "workers.mjs", content: workers },
        { path: "api.mjs", content: apiModuleSource },
        { path: "runtime.mjs", content: runtime },
      ];
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          list.map(({ path, content }) => `${path}\0${content}\0`).join(""),
        ),
      );
      return {
        sha256: [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
        files: list,
      };
    })();
    cache.set(entry, files);
  }
  return files;
};
