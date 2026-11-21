import type { ThreadId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import type { Bindings } from "../../http/types.js";
import {
  DaemonUnavailable,
  requestThreadSandbox,
  type SandboxChunk,
  SandboxDaemonOutdated,
  SandboxRequestInvalid,
} from "../../threads/daemon-client.js";
import {
  DXD_SANDBOX_MAX_READ_BYTES,
  DXD_SANDBOX_MAX_TIMEOUT_MS,
  DXD_SANDBOX_MAX_WRITE_BYTES,
  type DxdSandboxOperation,
  type DxdSandboxResult,
} from "../dxd/protocol.js";
import {
  type OrbExecOptions,
  type OrbExecResult,
  type OrbGuestClient,
  orbGuestSandbox,
} from "./orb-guest-client.js";

/** One sandbox operation's trip to the Thread's dxd and back. */
export interface DxdSandboxTransport {
  request(
    operation: DxdSandboxOperation,
    payload?: Uint8Array,
  ): Promise<SandboxChunk | DxdSandboxResult>;
}

/** The transport through the Thread execution object's socket to dxd. */
export const threadSandboxTransport = (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
): DxdSandboxTransport => ({
  request: (operation, payload) =>
    requestThreadSandbox(bindings, threadId, operation, payload),
});

/**
 * dxd never received the operation, so it may run on the provider route
 * instead. Thrown only when every attempt failed before dispatch.
 */
export class DxdRouteUnavailable extends Error {
  constructor(readonly reason: "unavailable" | "outdated" | "not-started") {
    super(`The Orb's dxd could not take the operation (${reason}).`);
  }
}

/** An Orb command gets E2B's 5 minutes unless it asks for another limit. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** A command whose frame passes this crosses as `sandbox.stage` chunks. */
const STAGE_ABOVE_BYTES = 1_536 * 1_024;
/** The most of one output stream a command returns; the tail is kept. */
const MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024;
/** The largest file `readFile` returns. */
const MAX_READ_FILE_BYTES = 256 * 1_024 * 1_024;
/** Attempts per operation; resends are safe (see `send`). */
const ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1_000];

type Failure = Extract<DxdSandboxResult, { kind: "failure" }>;

const NODE_CODES: Record<Failure["code"], string> = {
  invalid: "EINVAL",
  "not-found": "ENOENT",
  "not-directory": "ENOTDIR",
  "is-directory": "EISDIR",
  exists: "EEXIST",
  "not-empty": "ENOTEMPTY",
  "permission-denied": "EACCES",
  "too-large": "EFBIG",
  busy: "EBUSY",
  "upload-missing": "EIO",
  "not-started": "EIO",
  lost: "EIO",
  io: "EIO",
};

/** A failure as Node's fs reports it, so the agent reads the usual text. */
const failed = (failure: Failure, syscall: string, path?: string) => {
  const code = NODE_CODES[failure.code];
  const error = new Error(
    `${code}: ${failure.message}, ${syscall}${path === undefined ? "" : ` '${path}'`}`,
  ) as Error & { code: string; syscall: string; path?: string };
  error.code = code;
  error.syscall = syscall;
  if (path !== undefined) error.path = path;
  return error;
};

const unexpected = (syscall: string) =>
  new Error(`The Orb's dxd gave an unexpected answer to ${syscall}.`);

const randomId = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const decoder = () => new TextDecoder("utf-8", { fatal: false });

/**
 * The agent's commands and file access through the Thread's dxd: the same
 * operations as a provider's guest client, on every provider. A command
 * runs as `user` in `bash -l -c`, with the request's env, a process-group
 * timeout, and output as files dxd keeps by `execId`, so a resend after a
 * reconnect or a daemon restart returns the first run's result instead of
 * running it again. File bytes cross raw (`DXF1` reads, `DXW1` writes).
 */
export const dxdGuestClient = (
  transport: DxdSandboxTransport,
): OrbGuestClient => {
  /**
   * One operation, resent when the outcome is unknown: dxd answers a resend
   * without repeating the work (a command attaches by `execId`, a write
   * chunk lands at its offset). Only an operation no attempt may have
   * delivered throws `DxdRouteUnavailable`, which lets the caller run it on
   * the provider without running it twice.
   */
  const send = async (
    operation: DxdSandboxOperation,
    payload?: Uint8Array,
  ): Promise<{
    readonly answer: SandboxChunk | DxdSandboxResult;
    readonly resent: boolean;
  }> => {
    let delivered = false;
    let outdated = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return {
          answer: await transport.request(operation, payload),
          resent: attempt > 0 && delivered,
        };
      } catch (cause) {
        // A request dx itself refused is the same on every resend and on
        // the provider: it fails here.
        if (cause instanceof SandboxRequestInvalid)
          throw failed(
            { kind: "failure", code: "invalid", message: cause.detail },
            operation.operation,
          );
        if (cause instanceof SandboxDaemonOutdated) outdated = true;
        else if (!(cause instanceof DaemonUnavailable)) throw cause;
        else if (cause.outcome === "unknown") delivered = true;
        if (attempt + 1 >= ATTEMPTS) {
          if (!delivered)
            throw new DxdRouteUnavailable(
              outdated ? "outdated" : "unavailable",
            );
          throw new Error(
            `The Orb's dxd stopped answering ${operation.operation}; it may still be running.`,
          );
        }
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1_000);
      }
    }
  };

  const json = async (
    syscall: string,
    operation: DxdSandboxOperation,
    payload?: Uint8Array,
  ) => {
    const { answer, resent } = await send(operation, payload);
    if (answer.kind === "sandbox-chunk") throw unexpected(syscall);
    return { result: answer, resent };
  };

  const chunk = async (
    syscall: string,
    operation: Extract<
      DxdSandboxOperation,
      { operation: "sandbox.read" | "sandbox.output" }
    >,
    path?: string,
  ): Promise<SandboxChunk> => {
    const { answer } = await send(operation);
    if (answer.kind === "sandbox-chunk") return answer;
    if (answer.kind === "failure") throw failed(answer, syscall, path);
    throw unexpected(syscall);
  };

  /** One stream of a finished command too large to answer inline. */
  const output = async (
    execId: string,
    stream: "stdout" | "stderr",
    size: number,
  ) => {
    const start = Math.max(0, size - MAX_OUTPUT_BYTES);
    const bytes = new Uint8Array(size - start);
    let offset = start;
    while (offset < size) {
      const piece = await chunk("exec", {
        operation: "sandbox.output",
        execId,
        stream,
        offset,
        length: Math.min(DXD_SANDBOX_MAX_READ_BYTES, size - offset),
      });
      if (piece.bytes.byteLength === 0) break;
      bytes.set(piece.bytes.subarray(0, size - offset), offset - start);
      offset += piece.bytes.byteLength;
    }
    const text = decoder().decode(bytes.subarray(0, offset - start));
    return start === 0
      ? text
      : `[dx: the first ${start} bytes of this output were dropped]\n${text}`;
  };

  const exec = async (
    command: string,
    options: OrbExecOptions = {},
  ): Promise<OrbExecResult> => {
    const execId = randomId(12);
    const timeoutMs = Math.min(
      Math.max(1, Math.ceil(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      DXD_SANDBOX_MAX_TIMEOUT_MS,
    );
    const spec = {
      command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    };
    let operation: DxdSandboxOperation = {
      operation: "sandbox.exec",
      execId,
      timeoutMs,
      ...spec,
    };
    const encoded = new TextEncoder().encode(JSON.stringify(spec));
    if (encoded.byteLength > STAGE_ABOVE_BYTES) {
      for (let offset = 0; offset < encoded.byteLength; ) {
        const piece = encoded.subarray(
          offset,
          offset + DXD_SANDBOX_MAX_WRITE_BYTES,
        );
        const next = offset + piece.byteLength;
        const { result } = await json(
          "exec",
          {
            operation: "sandbox.stage",
            execId,
            offset,
            last: next >= encoded.byteLength,
          },
          piece,
        );
        if (result.kind === "failure") throw failed(result, "exec");
        offset = next;
      }
      operation = {
        operation: "sandbox.exec",
        execId,
        timeoutMs,
        staged: true,
      };
    }
    // The agent's Stop ends the command, as E2B does; Flue has already
    // rejected the call.
    const cancel = () => {
      void transport
        .request({ operation: "sandbox.cancel", execId })
        .catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    let ran: Extract<DxdSandboxResult, { kind: "exec" }>;
    try {
      const { result } = await json("exec", operation);
      // dxd could not prepare it (a full disk): it never started, so the
      // provider may run it.
      if (result.kind === "failure" && result.code === "not-started")
        throw new DxdRouteUnavailable("not-started");
      if (result.kind === "failure") throw failed(result, "exec");
      if (result.kind !== "exec") throw unexpected("exec");
      ran = result;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
    // The command ran: from here nothing may send it to the provider.
    const stream = async (
      name: "stdout" | "stderr",
      inline: string | null,
      size: number,
    ) => {
      if (inline !== null) return inline;
      try {
        return await output(execId, name, size);
      } catch (cause) {
        throw new Error(
          `The command ran (exit ${ran.exitCode}); its ${name} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    };
    return {
      exitCode: ran.exitCode,
      timedOut: ran.timedOut,
      stdout: await stream("stdout", ran.stdout, ran.stdoutBytes),
      stderr: await stream("stderr", ran.stderr, ran.stderrBytes),
    };
  };

  const readFile = async (path: string): Promise<Uint8Array> => {
    for (let attempt = 0; ; attempt += 1) {
      const first = await chunk(
        "open",
        {
          operation: "sandbox.read",
          path,
          offset: 0,
          length: DXD_SANDBOX_MAX_READ_BYTES,
        },
        path,
      );
      const size = first.sizeBytes;
      if (first.bytes.byteLength >= size) return first.bytes;
      if (size > MAX_READ_FILE_BYTES)
        throw failed(
          {
            kind: "failure",
            code: "too-large",
            message: `file is larger than ${MAX_READ_FILE_BYTES} bytes`,
          },
          "open",
          path,
        );
      const content = new Uint8Array(size);
      content.set(first.bytes);
      let offset = first.bytes.byteLength;
      let changed = false;
      while (offset < size) {
        const piece = await chunk(
          "open",
          {
            operation: "sandbox.read",
            path,
            offset,
            length: Math.min(DXD_SANDBOX_MAX_READ_BYTES, size - offset),
          },
          path,
        );
        if (piece.version !== first.version || piece.sizeBytes !== size) {
          changed = true;
          break;
        }
        if (piece.bytes.byteLength === 0) break;
        content.set(piece.bytes, offset);
        offset += piece.bytes.byteLength;
      }
      if (!changed) return content.subarray(0, offset);
      // The file changed between ranges: read it again from the start, and
      // never hand back a mix of two versions (an edit would write it back).
      if (attempt >= 2)
        throw failed(
          {
            kind: "failure",
            code: "io",
            message: "the file kept changing while it was read",
          },
          "open",
          path,
        );
    }
  };

  const writeFile = async (path: string, content: Uint8Array) => {
    for (let attempt = 0; ; attempt += 1) {
      const upload = randomId(16);
      let missing = false;
      for (let offset = 0; ; ) {
        const piece = content.subarray(
          offset,
          offset + DXD_SANDBOX_MAX_WRITE_BYTES,
        );
        const next = offset + piece.byteLength;
        const last = next >= content.byteLength;
        const { result } = await json(
          "open",
          {
            operation: "sandbox.write",
            path,
            upload,
            offset,
            sizeBytes: content.byteLength,
            last,
          },
          piece,
        );
        if (result.kind === "failure") {
          // dxd restarted mid-upload and its staging file is gone.
          if (result.code === "upload-missing" && attempt === 0) {
            missing = true;
            break;
          }
          throw failed(result, "open", path);
        }
        if (last) {
          if (result.kind !== "written") throw unexpected("write");
          return;
        }
        offset = next;
      }
      if (!missing) return;
    }
  };

  const stat = async (path: string) => {
    const { result } = await json("stat", {
      operation: "sandbox.stat",
      path,
    });
    return result;
  };

  return {
    exec,
    readFile,
    writeFile,
    async stat(path) {
      const result = await stat(path);
      if (result.kind === "stat")
        return {
          isFile: result.isFile,
          isDirectory: result.isDirectory,
          isSymbolicLink: result.isSymbolicLink,
        };
      if (result.kind === "missing")
        throw failed(
          {
            kind: "failure",
            code: "not-found",
            message: "no such file or directory",
          },
          "stat",
          path,
        );
      if (result.kind === "failure") throw failed(result, "stat", path);
      throw unexpected("stat");
    },
    async readdir(path) {
      const { result } = await json("scandir", {
        operation: "sandbox.readdir",
        path,
      });
      if (result.kind === "entries") return [...result.names];
      if (result.kind === "failure") throw failed(result, "scandir", path);
      throw unexpected("scandir");
    },
    async exists(path) {
      // `test -e || test -L`: a dangling link exists; an unreadable parent
      // reads as absent, as the shell's test does.
      return (await stat(path)).kind === "stat";
    },
    async mkdir(path) {
      const { result } = await json("mkdir", {
        operation: "sandbox.mkdir",
        path,
      });
      if (result.kind === "failure") throw failed(result, "mkdir", path);
    },
    async rm(path, options) {
      const { result, resent } = await json("rm", {
        operation: "sandbox.rm",
        path,
        recursive: options?.recursive === true,
        force: options?.force === true,
      });
      if (result.kind !== "failure") return;
      // A resend of a delete that already happened finds nothing to delete.
      if (resent && result.code === "not-found") return;
      throw failed(result, "rm", path);
    },
  };
};

/** Why a sandbox took the route it did; logged per sandbox. */
export type WorkspaceSandboxRoute =
  | { readonly route: "dxd"; readonly release: string | null }
  | {
      readonly route: "provider";
      readonly reason:
        | "flag-off"
        | "unsupported"
        | "not-ready"
        | "outdated"
        | "flag-unreadable";
    };

const SANDBOX_METHODS = [
  "exec",
  "readFile",
  "readFileBuffer",
  "writeFile",
  "stat",
  "readdir",
  "exists",
  "mkdir",
  "rm",
  "snapshotWorkspaceContext",
] as const;

/**
 * The agent's Flue sandbox on the dxd route. An operation dxd never received
 * (its daemon went away and did not come back, or was replaced by an older
 * one) runs on the provider's sandbox instead, so one command never runs on
 * both routes; `onFallback` records it.
 */
export const dxdRoutedSandbox = (input: {
  readonly client: OrbGuestClient;
  readonly cwd: string;
  readonly provider: () => Promise<Sandbox>;
  readonly onFallback: (operation: string, cause: DxdRouteUnavailable) => void;
}): Sandbox => {
  const dxd = orbGuestSandbox(input.client, input.cwd, { cancellable: true });
  let provider: Promise<Sandbox> | undefined;
  const routed = { ...dxd } as Record<string, unknown>;
  for (const method of SANDBOX_METHODS) {
    const own = dxd[method] as
      | ((...args: Array<unknown>) => Promise<unknown>)
      | undefined;
    if (own === undefined) continue;
    routed[method] = async (...args: Array<unknown>) => {
      try {
        return await own(...args);
      } catch (cause) {
        if (!(cause instanceof DxdRouteUnavailable)) throw cause;
        input.onFallback(method, cause);
        provider ??= input.provider();
        const fallback = (await provider)[method] as
          | ((...args: Array<unknown>) => Promise<unknown>)
          | undefined;
        if (fallback === undefined) throw cause;
        return fallback.apply(await provider, args);
      }
    };
  }
  return routed as unknown as Sandbox;
};
