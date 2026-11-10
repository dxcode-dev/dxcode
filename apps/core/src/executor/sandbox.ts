import type { Sandbox } from "@flue/runtime";
import type { ThreadExecutorObject } from "./executor-object.js";

/**
 * A Thread's executor as a Flue sandbox. A Thread in `executor` execution
 * mode that runs Claude Code mounts it instead of an Orb, so Claude Code
 * runs on dx's own small container and no Orb starts
 * (wiki/runtime-architecture.md#execution-modes). A dx agent Thread in
 * executor mode mounts no sandbox at all and never reaches this module.
 */

const WORKSPACE = "/home/user/workspace/repo";

type ExecutorNamespace = DurableObjectNamespace<ThreadExecutorObject>;

let executors: ExecutorNamespace | undefined;

/** The Worker entry hands over its `THREAD_EXECUTOR` binding, when bound. */
export const bindThreadExecutors = (
  namespace: ExecutorNamespace | undefined,
) => {
  executors = namespace;
};

/** Whether this deployment can run an executor. */
export const executorAvailable = () => executors !== undefined;

const stub = (threadId: string) => {
  if (executors === undefined)
    throw new Error(
      "This deployment has no executor (THREAD_EXECUTOR), so a Claude Code Space cannot run here.",
    );
  return executors.get(executors.idFromName(threadId));
};

/** Starts the Thread's executor early, so its cold start overlaps. */
export const warmExecutor = (threadId: string) => stub(threadId).warm();

/**
 * Releases the Thread's executor: `archive` saves Claude's session and stops
 * the container; `destroy` stops it and deletes the saved session. Nothing
 * to do where no executor is bound.
 */
export const releaseExecutor = async (
  threadId: string,
  mode: "archive" | "destroy",
) => {
  if (executors === undefined) return;
  const executor = stub(threadId);
  await (mode === "archive" ? executor.stop() : executor.forget());
};

/**
 * The Claude Code Threads this isolate runs on their executor, each with the
 * Claude built-in tools its profile keeps (`--tools`). The render registers
 * a Thread before its first model call; the Claude Code provider's sandbox
 * reconnect and launch read it.
 */
const executorThreads = new Map<
  string,
  { readonly builtInTools: ReadonlyArray<string> }
>();

export const runClaudeCodeOnExecutor = (
  threadId: string,
  builtInTools: ReadonlyArray<string>,
) => {
  executorThreads.set(threadId, { builtInTools });
};

/** The Thread's executor settings, or undefined for a Thread in an Orb. */
export const claudeCodeExecutor = (threadId: string) =>
  executorThreads.get(threadId);

const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);

const resolvePath = (path: string) => {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${WORKSPACE}/${path}`)
    .split("/")
    .filter((segment) => segment !== "" && segment !== "."))
    if (part === "..") parts.pop();
    else parts.push(part);
  return `/${parts.join("/")}`;
};

const abortable = <A>(promise: Promise<A>, signal: AbortSignal | undefined) =>
  signal === undefined
    ? promise
    : new Promise<A>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", abort);
        });
      });

export const executorSandbox = (threadId: string): Sandbox => {
  const executor = stub(threadId);
  return {
    cwd: WORKSPACE,
    resolvePath,
    exec: async (command, options) => {
      const result = await abortable(
        executor.exec(command, {
          cwd: resolvePath(options?.cwd ?? WORKSPACE),
          ...(options?.env === undefined ? {} : { env: options.env }),
          ...(options?.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        }),
        options?.signal,
      );
      return {
        stdout: decode(result.stdout),
        stderr: decode(result.stderr),
        exitCode: result.exitCode,
      };
    },
    readFile: async (path) =>
      decode(await executor.readFile(resolvePath(path))),
    readFileBuffer: (path) => executor.readFile(resolvePath(path)),
    writeFile: (path, content) =>
      executor.writeFile(
        resolvePath(path),
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
      ),
    stat: async (path) => {
      const stat = await executor.stat(resolvePath(path));
      return {
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymbolicLink,
        size: stat.size,
        mtime: new Date(stat.mtimeMs),
      };
    },
    readdir: (path) => executor.readdir(resolvePath(path)),
    exists: (path) => executor.exists(resolvePath(path)),
    mkdir: (path, options) =>
      executor.mkdir(resolvePath(path), options?.recursive === true),
    rm: (path, options) =>
      executor.rm(
        resolvePath(path),
        options?.recursive === true,
        options?.force === true,
      ),
  };
};
