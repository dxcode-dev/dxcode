import { DurableObject } from "cloudflare:workers";
import { claudeCodeLogger } from "../logging.js";

/**
 * One Thread's executor: a small Cloudflare container on dx's account that
 * runs an agent CLI for a Thread whose execution mode is `executor`, so the
 * Thread needs no Orb (see wiki/runtime-architecture.md#execution-modes).
 * Today the only runtime is Claude Code (`deploy/executor/claude-code`); Core
 * uses the container as the Claude Code provider's sandbox
 * (`executor/sandbox.ts`), so the launch script, the dx tool bridge, and run
 * reading are the same as in an Orb. No repository, dxd, or workspace
 * secrets are here. It runs in the Orb Worker beside the Orb container
 * object, bound to its own container application.
 *
 * The container stops after `IDLE_MS` without a call from Core. Its disk
 * goes with it, so before it stops this object saves Claude's session files
 * (`~/.claude/projects`, dx's session pointer, and where each turn left the
 * session) in its own storage, and restores them when the container starts
 * again; `--resume` then finds the session, and an edit can fork it. Archiving the Thread saves the session and stops the container
 * (`stop`); deleting it also deletes the saved session (`forget`).
 */

/** The container image for each agent runtime, by name in the image map. */
export const EXECUTOR_IMAGES = { "claude-code": "claude-code" } as const;

/** 1/4 vCPU, 1 GiB memory, 4 GB disk. Claude Code starts in about 210 MB. */
const INSTANCE = "basic";
/** Ten minutes: long enough to keep a back-and-forth warm, short enough to cost little. */
const IDLE_MS = 10 * 60_000;
/** Keeps this object resident while its container runs (see the Orb's). */
const HEARTBEAT_MS = 10_000;
const READY_MS = 90_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const OUTPUT_DRAIN_MS = 2_000;
/** Storage values stay under the 2 MB limit. */
const SESSION_CHUNK = 1_500_000;
const SESSION_COUNT = "session:count";
const LAST_USE = "last-use";
/**
 * Samples the container's used memory (MemTotal - MemAvailable) every second
 * and keeps the peak, so the stop log shows how much of the 1 GiB a run used.
 */
const MEMORY_SAMPLER = `peak=0
while :; do
  used=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t-a}' /proc/meminfo)
  if [ "$used" -gt "$peak" ]; then peak=$used; echo "$peak" > /tmp/dx-memory-peak; fi
  sleep 1
done
`;
const SESSION_PATHS = [
  ".claude/projects",
  ".local/state/dx-claude-code/session",
  // Where each turn left Claude's session: an edit forks the session there.
  ".local/state/dx-claude-code/turns",
];
const HOME = "/home/user";
const ENVIRONMENT = {
  HOME,
  USER: "user",
  LOGNAME: "user",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
};

interface Process {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

/** The `ctx.container` surface this object uses. */
interface Runtime {
  readonly running: boolean;
  readonly images?: Readonly<Record<string, string>>;
  start(options: {
    readonly image?: string;
    readonly instance: string;
    readonly enableInternet: boolean;
  }): void;
  exec(
    command: string[],
    options?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: ReadableStream;
      readonly stdout?: "pipe";
      readonly stderr?: "pipe";
    },
  ): Promise<Process>;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
}

export interface ExecutorResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
}

export interface ExecutorStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);

const collect = async (stream: ReadableStream<Uint8Array> | null) => {
  if (stream === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size >= OUTPUT_LIMIT) continue;
    const kept = value.subarray(0, OUTPUT_LIMIT - size);
    chunks.push(kept);
    size += kept.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

export class ThreadExecutorObject extends DurableObject {
  readonly #container: Runtime;
  #ready: Promise<void> | undefined;
  /**
   * When Core last called, or 0 when this instance has not seen a call:
   * Cloudflare may recreate the object between alarms, so the idle clock
   * also lives in storage (`LAST_USE`), written at most once per heartbeat.
   */
  #lastUse = 0;
  #storedLastUse = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const container = ctx.container as unknown as Runtime | undefined;
    if (container === undefined)
      throw new Error("The executor object has no container binding.");
    this.#container = container;
  }

  /** Starts the container if it is down; Core calls it to overlap a cold start. */
  async warm() {
    await this.#use();
  }

  /**
   * Saves Claude's session and stops the container: the Thread was
   * archived. A restored Thread's next call starts it again, with the
   * session.
   */
  async stop() {
    this.#ready = undefined;
    if (this.#container.running) {
      await this.#saveSession().catch((error: unknown) => {
        claudeCodeLogger.warn("Executor session was not saved.", {
          event: "executor_session_save_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await this.#container.destroy().catch(() => undefined);
    }
    await this.ctx.storage.deleteAlarm();
    claudeCodeLogger.info("Executor stopped.", { event: "executor_stopped" });
  }

  /**
   * Stops the container without saving and deletes everything this object
   * stored, including Claude's saved session: the Thread was archived or
   * deleted. A later call starts a fresh container with no session.
   */
  async forget() {
    this.#ready = undefined;
    if (this.#container.running)
      await this.#container.destroy().catch(() => undefined);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    claudeCodeLogger.info("Executor forgotten.", {
      event: "executor_forgotten",
    });
  }

  async exec(
    command: string,
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<ExecutorResult> {
    await this.#use();
    const seconds =
      options.timeoutMs === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.timeoutMs / 1000));
    return this.#run(
      [
        ...(seconds === undefined
          ? []
          : ["timeout", "--kill-after=5s", `${seconds}s`]),
        "bash",
        "-l",
        "-c",
        command,
      ],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
      },
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.#file("read", 'exec cat -- "$1"', [path]);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await this.#file(
      "write",
      'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
      [path],
      content,
    );
  }

  async stat(path: string): Promise<ExecutorStat> {
    const out = decode(
      await this.#file("stat", 'exec stat -c "%F|%s|%Y" -- "$1"', [path]),
    ).trim();
    const [kind = "", size = "0", mtime = "0"] = out.split("|");
    const link = decode(
      await this.#file("stat", '[ -L "$1" ] && echo 1 || echo 0', [path]),
    ).trim();
    return {
      isFile: kind.startsWith("regular"),
      isDirectory: kind === "directory",
      isSymbolicLink: link === "1",
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    };
  }

  async readdir(path: string): Promise<string[]> {
    return decode(await this.#file("readdir", 'exec ls -A1 -- "$1"', [path]))
      .split("\n")
      .filter((name) => name !== "");
  }

  async exists(path: string): Promise<boolean> {
    await this.#use();
    const result = await this.#run(["test", "-e", path]);
    return result.exitCode === 0;
  }

  async mkdir(path: string, recursive = false): Promise<void> {
    await this.#file(
      "mkdir",
      recursive ? 'exec mkdir -p -- "$1"' : 'exec mkdir -- "$1"',
      [path],
    );
  }

  async rm(path: string, recursive = false, force = false): Promise<void> {
    const flags = `${recursive ? "r" : ""}${force ? "f" : ""}`;
    await this.#file(
      "rm",
      flags === "" ? 'exec rm -- "$1"' : `exec rm -${flags} -- "$1"`,
      [path],
    );
  }

  override async alarm() {
    if (!this.#container.running) {
      this.#ready = undefined;
      return;
    }
    const lastUse = await this.#idleClock();
    if (Date.now() - lastUse >= IDLE_MS) {
      try {
        await this.#saveSession();
      } catch (error) {
        claudeCodeLogger.warn("executor session was not saved.", {
          event: "executor_session_save_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const memory = await this.#memory().catch(() => undefined);
      this.#ready = undefined;
      await this.#container.destroy().catch(() => undefined);
      claudeCodeLogger.info("executor stopped after idling.", {
        event: "executor_stopped",
        ...memory,
      });
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async #use() {
    this.#lastUse = Date.now();
    if (this.#ready === undefined || !this.#container.running) {
      // A running container this object lost track of (a restart) is ready.
      this.#ready = this.#container.running
        ? this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)
        : this.#start();
      this.#ready.catch(() => {
        this.#ready = undefined;
      });
    }
    await this.#ready;
  }

  async #start() {
    const started = Date.now();
    const image = this.#container.images?.[EXECUTOR_IMAGES["claude-code"]];
    this.#container.start({
      ...(image === undefined ? {} : { image }),
      instance: INSTANCE,
      enableInternet: true,
    });
    let lastError: unknown;
    for (;;) {
      if (Date.now() - started > READY_MS)
        throw new Error(
          `The executor did not start: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
      try {
        const probe = await this.#container.exec(["true"]);
        if ((await probe.exitCode) === 0) break;
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    const readyMs = Date.now() - started;
    await this.#run(
      [
        "sh",
        "-c",
        "cat > /tmp/dx-memory.sh && { setsid nohup sh /tmp/dx-memory.sh > /dev/null 2>&1 < /dev/null & }",
      ],
      {
        stdin: new TextEncoder().encode(MEMORY_SAMPLER),
      },
    ).catch(() => undefined);
    // A backstop: this object stops the container itself after IDLE_MS.
    await this.#container.setInactivityTimeout(IDLE_MS + 5 * 60_000);
    const restored = await this.#restoreSession().catch((error: unknown) => {
      claudeCodeLogger.warn("executor session was not restored.", {
        event: "executor_session_restore_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    });
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    claudeCodeLogger.info("executor started.", {
      event: "executor_started",
      instance: INSTANCE,
      readyMs,
      restoredSessionBytes: restored,
      totalMs: Date.now() - started,
    });
  }

  /** The peak used memory the sampler saw, and the container's total. */
  async #memory() {
    const result = await this.#run([
      "sh",
      "-c",
      "cat /tmp/dx-memory-peak 2>/dev/null || echo 0; awk '/^MemTotal:/{print $2}' /proc/meminfo",
    ]);
    const [peak = "0", total = "0"] = decode(result.stdout).trim().split("\n");
    return {
      peakUsedMiB: Math.round(Number(peak) / 1024),
      totalMiB: Math.round(Number(total) / 1024),
    };
  }

  /**
   * The last call's time, from this instance or, when it has seen none (a
   * recreated object), from storage; this instance's newer time is stored.
   */
  async #idleClock() {
    if (this.#lastUse === 0) {
      this.#lastUse =
        (await this.ctx.storage.get<number>(LAST_USE)) ?? Date.now();
      this.#storedLastUse = this.#lastUse;
    }
    if (this.#lastUse !== this.#storedLastUse) {
      await this.ctx.storage.put(LAST_USE, this.#lastUse);
      this.#storedLastUse = this.#lastUse;
    }
    return this.#lastUse;
  }

  async #saveSession() {
    const result = await this.#run([
      "sh",
      "-c",
      `cd ${HOME} && set -- && for p in ${SESSION_PATHS.join(" ")}; do [ -e "$p" ] && set -- "$@" "$p"; done; [ $# -gt 0 ] || exit 0; exec tar czf - "$@"`,
    ]);
    if (result.exitCode !== 0 || result.stdout.byteLength === 0) return;
    const bytes = result.stdout;
    const count = Math.ceil(bytes.byteLength / SESSION_CHUNK);
    const previous = (await this.ctx.storage.get<number>(SESSION_COUNT)) ?? 0;
    const entries: Record<string, unknown> = { [SESSION_COUNT]: count };
    for (let index = 0; index < count; index += 1)
      entries[`session:${index}`] = bytes.slice(
        index * SESSION_CHUNK,
        (index + 1) * SESSION_CHUNK,
      );
    await this.ctx.storage.put(entries);
    for (let index = count; index < previous; index += 1)
      await this.ctx.storage.delete(`session:${index}`);
    claudeCodeLogger.info("executor session saved.", {
      event: "executor_session_saved",
      bytes: bytes.byteLength,
    });
  }

  async #restoreSession() {
    const count = (await this.ctx.storage.get<number>(SESSION_COUNT)) ?? 0;
    if (count === 0) return 0;
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < count; index += 1) {
      const chunk = await this.ctx.storage.get<Uint8Array>(`session:${index}`);
      if (chunk === undefined) return 0;
      chunks.push(chunk);
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result = await this.#run(["tar", "xzf", "-", "-C", HOME], {
      stdin: bytes,
    });
    if (result.exitCode !== 0) throw new Error(decode(result.stderr).trim());
    return size;
  }

  async #file(
    operation: string,
    script: string,
    args: string[],
    stdin?: Uint8Array,
  ) {
    await this.#use();
    const result = await this.#run(["sh", "-c", script, "sh", ...args], {
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0)
      throw new Error(
        `executor ${operation} failed: ${
          decode(result.stderr).trim() || `exit ${result.exitCode}`
        }`,
      );
    return result.stdout;
  }

  async #run(
    argv: string[],
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: Uint8Array;
    } = {},
  ): Promise<ExecutorResult> {
    const process = await this.#container.exec(argv, {
      env: { ...ENVIRONMENT, ...options.env },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.stdin === undefined
        ? {}
        : { stdin: streamOf(options.stdin) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = collect(process.stdout);
    const stderr = collect(process.stderr);
    const exitCode = await process.exitCode;
    this.#lastUse = Date.now();
    // A background process that inherited the pipes keeps them open; its
    // output after the command exits is not the command's.
    const drained = await Promise.race([
      Promise.all([stdout, stderr]),
      sleep(OUTPUT_DRAIN_MS).then(() => undefined),
    ]);
    const [out, err] = drained ?? [new Uint8Array(), new Uint8Array()];
    return { stdout: out, stderr: err, exitCode };
  }
}
