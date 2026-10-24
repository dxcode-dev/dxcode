import type { CloudflareContainerInstance } from "@dx/domain";
import { orbContainerLogger } from "../../logging.js";

/**
 * One Thread's Cloudflare Containers workspace, owned by one Durable Object
 * instance (the Orb container object) in the deployer's account.
 *
 * Containers' disk is ephemeral, so this object makes the filesystem
 * durable with snapshots (`durable_object` scheduling policy):
 *
 * - **Open** starts the container from the Thread's latest snapshot, or from
 *   the standard Orb image the first time. The image's entrypoint
 *   (`dx-orb-init`) starts dxd again, so dxd reconnects to Core on its own.
 * - **Pause** (the idle deadline, or archive) snapshots the filesystem and
 *   stops the container. Processes and memory do not survive
 *   (`execution.pause-resume` with `preserves: "filesystem"`).
 * - **Destroy** stops the container and forgets its snapshot; Cloudflare
 *   expires it. The Worker API cannot delete or list snapshots.
 * - **Refresh**: a snapshot expires 30 days after it was created or last
 *   restored. A paused workspace's alarm restores it (with a sleeping
 *   entrypoint, no Internet, no dxd) and re-snapshots it after 25 days, so
 *   archived and long-idle Threads stay resumable.
 *
 * Commands and files go through `ctx.container.exec()`; nothing in the
 * container serves them. While the container runs, a short heartbeat alarm
 * keeps this object resident: a Durable Object that restarts (a deploy of
 * the Orb Worker, a runtime restart) loses its container inactivity timeout,
 * and Cloudflare stops an orphaned container shortly after, without the
 * snapshot. The heartbeat re-arms the timeout within seconds.
 *
 * Core reaches this object only by RPC; every method here is that surface.
 */

/** The `ctx.container` surface this object uses. */
export interface OrbContainerRuntime {
  readonly running: boolean;
  start(options: OrbContainerStartOptions): void;
  exec(
    command: string[],
    options?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: ReadableStream;
      readonly stdout?: "pipe";
      readonly stderr?: "pipe";
    },
  ): Promise<OrbContainerProcess>;
  snapshotContainer(options: {
    readonly name?: string;
  }): Promise<OrbContainerSnapshot>;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
}

export interface OrbContainerProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

export interface OrbContainerSnapshot {
  readonly id: string;
  readonly size: number;
  readonly name?: string;
}

export type OrbContainerStartOptions = {
  readonly enableInternet: boolean;
  readonly instance: CloudflareContainerInstance;
  readonly entrypoint?: string[];
  readonly env?: Readonly<Record<string, string>>;
} & (
  | { readonly image: string; readonly containerSnapshot?: never }
  | { readonly containerSnapshot: { readonly id: string } }
);

export interface OrbContainerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/** What this object remembers about its Thread's workspace. */
export interface OrbWorkspaceState {
  readonly version: 1;
  /** Fixed when the workspace is created; a wake never resizes it. */
  readonly instance: CloudflareContainerInstance;
  readonly createdAt: number;
  /**
   * `active`: the container should be running. `paused`: stopped, restorable
   * from `snapshot` (or, before the first pause, never snapshotted).
   * `destroyed`: released for good.
   */
  readonly status: "active" | "paused" | "destroyed";
  readonly snapshot?: {
    readonly id: string;
    readonly size: number;
    /** When it was taken or last restored: Cloudflare's 30-day TTL clock. */
    readonly refreshedAt: number;
  };
  /** Pause after this time unless Core renews it. */
  readonly idleDeadline: number;
  /**
   * When the running container last started (a create, a wake, or a
   * restart); every process in it, Terminal shells included, is younger.
   */
  readonly startedAt?: number;
}

export type OrbOpenResult =
  | {
      readonly kind: "ready";
      readonly sandboxId: string;
      /**
       * `running`: the container was up. `paused`: restored from its
       * snapshot (processes restarted). `created`: started from the image.
       */
      readonly residency: "running" | "paused" | "created";
      /** When the container's processes started; see `startedAt`. */
      readonly processesStartedAt?: number;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "destroyed" };

export interface OrbExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

export interface OrbExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export interface OrbFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

const STATE_KEY = "workspace";
/** While the container runs, the alarm fires this often. */
export const ORB_HEARTBEAT_MS = 10_000;
/** Restore and re-snapshot a paused workspace this long after its TTL clock. */
export const ORB_SNAPSHOT_REFRESH_MS = 25 * 24 * 60 * 60 * 1000;
/** Cloudflare stops a container this long after its object goes quiet. */
const MAX_CONTAINER_INACTIVITY_MS = 6 * 60 * 60 * 1000;
const CONTAINER_INACTIVITY_MARGIN_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 90_000;
const READY_RETRY_MS = 100;
/** While a start waits for readiness, log its progress this often. */
const READY_PROGRESS_LOG_MS = 30_000;
/**
 * How long an operation that must follow the restart work waits for it.
 * Storage can stall for minutes; past this the operation goes ahead.
 */
const RESTART_WAIT_MS = 10_000;
/** How long stopping a container that never became ready may take. */
const ABANDON_START_MS = 5_000;
/** A command's output kept in this object's memory, per stream. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** The largest file read in one call (one RPC result). */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** After the command exits, how long its streams may keep draining. */
const OUTPUT_DRAIN_MS = 250;
/** Beyond `timeoutMs`, how long `timeout` gets before this object kills it. */
const TIMEOUT_BACKSTOP_MS = 15_000;
const SIGKILL = 9;

/** The image user (`user`, uid 1000) and the environment E2B gives commands. */
const BASE_ENVIRONMENT = {
  HOME: "/home/user",
  USER: "user",
  LOGNAME: "user",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
} as const;

/**
 * The entrypoint's environment. Cloudflare names the host after the 64-hex
 * object ID; `dx-orb-init` sets this short, stable name instead, so the
 * Terminal prompt reads `user@cloudflare` (E2B's reads `user@e2b`).
 */
const ORB_START_ENVIRONMENT = { DX_ORB_HOSTNAME: "cloudflare" } as const;

const textDecoder = () => new TextDecoder("utf-8", { fatal: false });

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const failure = (operation: string, detail: string) =>
  new Error(`Orb container ${operation} failed: ${detail}`.trim());

/** `promise`, or `undefined` once `durationMs` passes. */
const within = async <A>(
  promise: Promise<A>,
  durationMs: number,
): Promise<A | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), durationMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Reads a stream to the end, keeping at most `limit` bytes. */
const collect = (
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): {
  readonly done: Promise<Uint8Array>;
  readonly cancel: () => Promise<void>;
  readonly truncated: () => boolean;
} => {
  if (stream === null)
    return {
      done: Promise.resolve(new Uint8Array()),
      cancel: async () => {},
      truncated: () => false,
    };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let dropped = false;
  let cancelled = false;
  const done = (async () => {
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (kept + value.byteLength > limit) dropped = true;
        if (kept >= limit) continue;
        const slice = value.subarray(0, limit - kept);
        chunks.push(slice);
        kept += slice.byteLength;
      }
    } catch (cause) {
      if (!cancelled) throw cause;
    }
    const bytes = new Uint8Array(kept);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  })();
  return {
    done,
    cancel: async () => {
      cancelled = true;
      await reader.cancel().catch(() => undefined);
    },
    truncated: () => dropped,
  };
};

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

export interface OrbContainerControllerInput {
  readonly container: OrbContainerRuntime;
  readonly storage: OrbContainerStorage;
  /** The standard Orb image (`ctx.container.images.orb`). */
  readonly image: () => string | undefined;
  readonly sandboxId: string;
  readonly now?: () => number;
}

/**
 * The Orb container object's behavior, independent of the Durable Object
 * class so it can be tested with a fake container and storage.
 */
export class OrbContainerController {
  readonly #container: OrbContainerRuntime;
  readonly #storage: OrbContainerStorage;
  readonly #image: () => string | undefined;
  readonly #sandboxId: string;
  readonly #now: () => number;
  #state: OrbWorkspaceState | undefined | null = null;
  /** Serializes start, pause, refresh, and destroy. */
  #lifecycle: Promise<unknown> = Promise.resolve();
  #busy = 0;
  #inflight = 0;
  /** The restart work (`resumeAfterRestart`) while it runs. */
  #restart: Promise<void> | undefined;

  constructor(input: OrbContainerControllerInput) {
    this.#container = input.container;
    this.#storage = input.storage;
    this.#image = input.image;
    this.#sandboxId = input.sandboxId;
    this.#now = input.now ?? Date.now;
  }

  async #load(): Promise<OrbWorkspaceState | undefined> {
    if (this.#state === null) {
      const loaded = await this.#storage.get<OrbWorkspaceState>(STATE_KEY);
      // A read that stalled must not overwrite a save made meanwhile.
      if (this.#state === null) this.#state = loaded;
    }
    return this.#state;
  }

  async #save(state: OrbWorkspaceState) {
    this.#state = state;
    await this.#storage.put(STATE_KEY, state);
  }

  #exclusive<A>(operation: () => Promise<A>): Promise<A> {
    this.#busy += 1;
    const after = () => this.#afterRestart().then(operation);
    const run = this.#lifecycle.then(after, after);
    this.#lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.#busy -= 1;
    });
  }

  /**
   * Waits for the restart work, at most `RESTART_WAIT_MS`: the object
   * answers while storage stalls, and an operation that must follow the
   * restart does not hang behind it.
   */
  async #afterRestart() {
    const restart = this.#restart;
    if (restart === undefined) return;
    const startedAt = this.#now();
    const settled = await within(
      restart.then(() => true),
      RESTART_WAIT_MS,
    );
    if (settled === undefined)
      orbContainerLogger.warn("Orb container restart work is still running.", {
        event: "orb_container_restart_wait",
        sandboxId: this.#sandboxId,
        outcome: "timed_out",
        waitedMs: this.#now() - startedAt,
      });
  }

  async #idle() {
    while (this.#busy > 0) await this.#lifecycle;
  }

  async #schedule(at: number) {
    await this.#storage.setAlarm(at);
  }

  async #armInactivity(idleMs: number) {
    await this.#container.setInactivityTimeout(
      Math.min(
        MAX_CONTAINER_INACTIVITY_MS,
        idleMs + CONTAINER_INACTIVITY_MARGIN_MS,
      ),
    );
  }

  /**
   * The container accepts `exec` once it has started. Logs progress while it
   * waits, so a stalled start shows whether one probe hung
   * (`currentAttemptMs`) or probes kept failing (`attempts`, `lastFailure`).
   */
  async #waitReady(operation: string) {
    const startedAt = this.#now();
    const deadline = startedAt + READY_TIMEOUT_MS;
    let lastFailure: unknown;
    let attempts = 0;
    let attemptStartedAt = startedAt;
    let slowestAttemptMs = 0;
    const progress = (outcome: "waiting" | "ready" | "timed_out") => ({
      event: "orb_container_ready_wait",
      outcome,
      sandboxId: this.#sandboxId,
      operation,
      elapsedMs: this.#now() - startedAt,
      attempts,
      slowestAttemptMs,
      currentAttemptMs: this.#now() - attemptStartedAt,
      running: this.#container.running,
      ...(lastFailure === undefined
        ? {}
        : {
            lastFailure:
              lastFailure instanceof Error
                ? lastFailure.message
                : String(lastFailure),
          }),
    });
    const watchdog = setInterval(
      () =>
        orbContainerLogger.warn(
          "Orb container is not ready yet.",
          progress("waiting"),
        ),
      READY_PROGRESS_LOG_MS,
    );
    try {
      while (this.#now() < deadline) {
        attempts += 1;
        attemptStartedAt = this.#now();
        try {
          // A probe can hang without failing; the deadline bounds it.
          const exitCode = await within(
            this.#container.exec(["true"]).then((process) => process.exitCode),
            Math.max(0, deadline - this.#now()),
          );
          if (exitCode === undefined) {
            lastFailure = new Error("the readiness probe did not return");
            break;
          }
          if (exitCode === 0) {
            slowestAttemptMs = Math.max(
              slowestAttemptMs,
              this.#now() - attemptStartedAt,
            );
            orbContainerLogger.info(
              "Orb container is ready.",
              progress("ready"),
            );
            return;
          }
        } catch (cause) {
          lastFailure = cause;
        }
        slowestAttemptMs = Math.max(
          slowestAttemptMs,
          this.#now() - attemptStartedAt,
        );
        await sleep(READY_RETRY_MS);
      }
      orbContainerLogger.error(
        "Orb container did not become ready.",
        progress("timed_out"),
      );
    } finally {
      clearInterval(watchdog);
    }
    // Text the run-failure classifier reads as a platform failure.
    throw new Error(
      `Orb container ${operation} timed out after ${READY_TIMEOUT_MS / 1000} s: ${
        lastFailure instanceof Error ? lastFailure.message : "not ready"
      }`,
    );
  }

  /**
   * Starts the stopped container from its latest snapshot, or from the
   * image when it never paused. Runs under the lifecycle lock.
   */
  async #start(
    state: OrbWorkspaceState,
    idleMs: number,
    fresh = false,
    lockWaitMs = 0,
  ): Promise<"paused" | "created"> {
    const now = this.#now();
    const snapshot = state.snapshot;
    const details = {
      event: "orb_container_start",
      sandboxId: this.#sandboxId,
      source: snapshot === undefined ? "image" : "snapshot",
      ...(snapshot === undefined
        ? {}
        : {
            snapshotId: snapshot.id,
            snapshotSize: snapshot.size,
            snapshotAgeMs: now - snapshot.refreshedAt,
          }),
      instance: state.instance,
      fresh,
      lockWaitMs,
    };
    orbContainerLogger.info("Orb container start requested.", details);
    try {
      const residency = await this.#startContainer(state, idleMs, fresh, now);
      orbContainerLogger.info("Orb container started.", {
        ...details,
        outcome: "started",
        durationMs: this.#now() - now,
      });
      return residency;
    } catch (cause) {
      orbContainerLogger.error("Orb container start failed.", {
        ...details,
        outcome: "error",
        durationMs: this.#now() - now,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
  }

  async #startContainer(
    state: OrbWorkspaceState,
    idleMs: number,
    fresh: boolean,
    now: number,
  ): Promise<"paused" | "created"> {
    const snapshot = state.snapshot;
    if (snapshot === undefined) {
      const image = this.#image();
      if (image === undefined)
        throw failure("start", "the Orb image is not configured");
      if (!fresh)
        // Stopped before its first pause (a crash, or Cloudflare stopped
        // it): the filesystem is gone, and the image starts it over.
        orbContainerLogger.warn("Orb container restarted without a snapshot.", {
          event: "orb_container_restart_without_snapshot",
          sandboxId: this.#sandboxId,
        });
      this.#container.start({
        image,
        instance: state.instance,
        enableInternet: true,
        env: ORB_START_ENVIRONMENT,
      });
    } else
      this.#container.start({
        containerSnapshot: { id: snapshot.id },
        instance: state.instance,
        enableInternet: true,
        env: ORB_START_ENVIRONMENT,
      });
    try {
      await this.#waitReady("start");
    } catch (cause) {
      // A container that never became ready would pass for running on the
      // next open; stop it so a retry starts it again.
      await within(
        this.#container.destroy().catch(() => undefined),
        ABANDON_START_MS,
      );
      throw cause;
    }
    await this.#armInactivity(idleMs);
    await this.#save({
      ...state,
      status: "active",
      idleDeadline: Math.max(state.idleDeadline, this.#now() + idleMs),
      startedAt: now,
      ...(snapshot === undefined
        ? {}
        : { snapshot: { ...snapshot, refreshedAt: now } }),
    });
    await this.#schedule(this.#now() + ORB_HEARTBEAT_MS);
    return snapshot === undefined ? "created" : "paused";
  }

  /**
   * Core's create (`create: true`) or connect. A paused workspace is
   * restored; a new one starts from the image with `instance`, which stays
   * fixed afterwards.
   */
  async open(input: {
    readonly create: boolean;
    readonly instance: CloudflareContainerInstance;
    readonly idleMs: number;
  }): Promise<OrbOpenResult> {
    const requestedAt = this.#now();
    return this.#exclusive(async () => {
      const lockWaitMs = this.#now() - requestedAt;
      let state = await this.#load();
      let fresh = false;
      if (state === undefined) {
        if (!input.create) return { kind: "missing" };
        fresh = true;
        const now = this.#now();
        state = {
          version: 1,
          instance: input.instance,
          createdAt: now,
          status: "active",
          idleDeadline: now + input.idleMs,
        };
        await this.#save(state);
      }
      if (state.status === "destroyed") return { kind: "destroyed" };
      if (this.#container.running) {
        const deadline = Math.max(
          state.idleDeadline,
          this.#now() + input.idleMs,
        );
        if (deadline !== state.idleDeadline || state.status !== "active")
          await this.#save({
            ...state,
            status: "active",
            idleDeadline: deadline,
          });
        return {
          kind: "ready",
          sandboxId: this.#sandboxId,
          residency: "running",
          ...(state.startedAt === undefined
            ? {}
            : { processesStartedAt: state.startedAt }),
        };
      }
      const residency = await this.#start(
        state,
        input.idleMs,
        fresh,
        lockWaitMs,
      );
      const started = await this.#load();
      return {
        kind: "ready",
        sandboxId: this.#sandboxId,
        residency,
        ...(started?.startedAt === undefined
          ? {}
          : { processesStartedAt: started.startedAt }),
      };
    });
  }

  /** Whether the container runs now; lets Core report a wake before it. */
  async status(): Promise<{
    readonly running: boolean;
    readonly status: OrbWorkspaceState["status"] | "missing";
  }> {
    const state = await this.#load();
    return {
      running: this.#container.running,
      status: state?.status ?? "missing",
    };
  }

  /** Core's idle deadline: pause `durationMs` from now unless renewed. */
  async setIdleDeadline(durationMs: number): Promise<void> {
    await this.#afterRestart();
    const state = await this.#load();
    if (state === undefined || state.status === "destroyed") return;
    await this.#save({ ...state, idleDeadline: this.#now() + durationMs });
    if (this.#container.running) await this.#armInactivity(durationMs);
  }

  /**
   * Runs an operation in the running container. A container that paused
   * meanwhile is restored first, as E2B resumes a paused sandbox on use.
   */
  async #use<A>(operation: () => Promise<A>): Promise<A> {
    await this.#afterRestart();
    while (true) {
      await this.#idle();
      if (this.#container.running) break;
      await this.#exclusive(async () => {
        if (this.#container.running) return;
        const state = await this.#load();
        if (state === undefined) throw failure("use", "no workspace");
        if (state.status === "destroyed")
          throw failure("use", "the workspace was destroyed");
        await this.#start(
          state,
          Math.max(ORB_HEARTBEAT_MS, state.idleDeadline - this.#now()),
        );
      });
    }
    this.#inflight += 1;
    try {
      return await operation();
    } finally {
      this.#inflight -= 1;
    }
  }

  async #run(
    argv: string[],
    options: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: Uint8Array;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    } = {},
  ) {
    const timeoutSeconds =
      options.timeoutMs === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.timeoutMs / 1000));
    const command =
      timeoutSeconds === undefined
        ? argv
        : // `timeout` signals the command's whole process group.
          ["timeout", "--kill-after=5s", `${timeoutSeconds}s`, ...argv];
    const startedAt = this.#now();
    const process = await this.#container.exec(command, {
      env: { ...BASE_ENVIRONMENT, ...options.env },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.stdin === undefined
        ? {}
        : { stdin: streamOf(options.stdin) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = collect(
      process.stdout,
      options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    );
    const stderr = collect(process.stderr, MAX_OUTPUT_BYTES);
    let exited = false;
    const backstop =
      timeoutSeconds === undefined
        ? undefined
        : setTimeout(
            () => {
              // Signalling a process that already exited raises an internal
              // error in the Durable Object.
              if (!exited) process.kill(SIGKILL);
            },
            timeoutSeconds * 1000 + TIMEOUT_BACKSTOP_MS,
          );
    let exitCode: number;
    try {
      exitCode = await process.exitCode;
    } finally {
      exited = true;
      if (backstop !== undefined) clearTimeout(backstop);
    }
    // A background process that inherited the pipes keeps them open; its
    // output after the command exits is not the command's.
    const drained = await Promise.race([
      Promise.all([stdout.done, stderr.done]),
      sleep(OUTPUT_DRAIN_MS).then(() => undefined),
    ]);
    if (drained === undefined)
      await Promise.all([stdout.cancel(), stderr.cancel()]);
    const [out, err] =
      drained ?? (await Promise.all([stdout.done, stderr.done]));
    const timedOut =
      timeoutSeconds !== undefined &&
      (exitCode === 124 || exitCode === 137) &&
      this.#now() - startedAt >= timeoutSeconds * 1000;
    return {
      exitCode,
      stdout: out,
      stderr: err,
      timedOut,
      truncated: stdout.truncated(),
    };
  }

  /** A shell command, as E2B runs it: `bash -l -c` as `user`. */
  exec(command: string, options: OrbExecOptions = {}): Promise<OrbExecResult> {
    return this.#use(async () => {
      const result = await this.#run(["bash", "-l", "-c", command], options);
      const decoder = textDecoder();
      return {
        stdout: decoder.decode(result.stdout),
        stderr: textDecoder().decode(result.stderr),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      };
    });
  }

  async #file(
    operation: string,
    script: string,
    args: string[],
    stdin?: Uint8Array,
  ) {
    const result = await this.#run(["sh", "-c", script, "sh", ...args], {
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0)
      throw failure(
        operation,
        textDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`,
      );
    return result.stdout;
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.#use(async () => {
      const result = await this.#run(
        ["sh", "-c", 'exec cat -- "$1"', "sh", path],
        { maxOutputBytes: MAX_FILE_BYTES },
      );
      if (result.exitCode !== 0)
        throw failure(
          "readFile",
          textDecoder().decode(result.stderr).trim() ||
            `exit ${result.exitCode}`,
        );
      if (result.truncated)
        throw failure(
          "readFile",
          `${path} is larger than ${MAX_FILE_BYTES} bytes`,
        );
      return result.stdout;
    });
  }

  /** Creates missing parent directories, as E2B's file write does. */
  writeFile(path: string, content: Uint8Array): Promise<void> {
    return this.#use(async () => {
      await this.#file(
        "writeFile",
        'mkdir -p -- "$(dirname -- "$1")" && exec cat > "$1"',
        [path],
        content,
      );
    });
  }

  stat(path: string): Promise<OrbFileStat> {
    return this.#use(async () => {
      const output = textDecoder().decode(
        await this.#file(
          "stat",
          'if [ -L "$1" ]; then l=1; else l=0; fi; t=$(stat -L -c %F -- "$1") || exit 1; printf "%s\\n%s" "$l" "$t"',
          [path],
        ),
      );
      const [link, type] = output.split("\n");
      return {
        isFile: type === "regular file" || type === "regular empty file",
        isDirectory: type === "directory",
        isSymbolicLink: link === "1",
      };
    });
  }

  readdir(path: string): Promise<string[]> {
    return this.#use(async () => {
      const output = textDecoder().decode(
        await this.#file(
          "readdir",
          'test -d "$1" || { echo "not a directory: $1" >&2; exit 1; }; find "$1" -mindepth 1 -maxdepth 1 -printf "%f\\0"',
          [path],
        ),
      );
      return output.split("\0").filter((name) => name.length > 0);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.#use(async () => {
      const result = await this.#run(
        ["sh", "-c", 'test -e "$1" || test -L "$1"', "sh", path],
        {},
      );
      return result.exitCode === 0;
    });
  }

  mkdir(path: string): Promise<void> {
    return this.#use(async () => {
      await this.#file("mkdir", 'exec mkdir -p -- "$1"', [path]);
    });
  }

  rm(
    path: string,
    options: { readonly recursive?: boolean; readonly force?: boolean } = {},
  ): Promise<void> {
    const flags = `${options.recursive ? "r" : ""}${options.force ? "f" : ""}`;
    return this.#use(async () => {
      await this.#file(
        "rm",
        flags === "" ? 'exec rm -- "$1"' : `exec rm -${flags} -- "$1"`,
        [path],
      );
    });
  }

  /**
   * Snapshot, then stop. With `keepIfActive`, a container that Core used
   * while the snapshot ran keeps running (the snapshot still becomes the
   * latest). Runs under the lifecycle lock.
   */
  async #pause(state: OrbWorkspaceState, keepIfActive: boolean) {
    const startedAt = this.#now();
    const snapshot = await this.#container.snapshotContainer({
      name: `dx-orb-${this.#sandboxId.slice(0, 16)}`,
    });
    const current = (await this.#load()) ?? state;
    const next: OrbWorkspaceState = {
      ...current,
      snapshot: {
        id: snapshot.id,
        size: snapshot.size,
        refreshedAt: this.#now(),
      },
    };
    if (
      keepIfActive &&
      (this.#inflight > 0 || current.idleDeadline > this.#now())
    ) {
      await this.#save(next);
      return "kept" as const;
    }
    await this.#container.destroy();
    await this.#save({ ...next, status: "paused" });
    orbContainerLogger.info("Orb container paused.", {
      event: "orb_container_paused",
      sandboxId: this.#sandboxId,
      snapshotBytes: snapshot.size,
      durationMs: this.#now() - startedAt,
    });
    await this.#schedule(this.#now() + ORB_SNAPSHOT_REFRESH_MS);
    return "paused" as const;
  }

  /** Archive: snapshot and stop now, whatever the idle deadline says. */
  pause(): Promise<"paused" | "stopped"> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (state === undefined || state.status === "destroyed") return "stopped";
      if (!this.#container.running) {
        if (state.status === "active")
          await this.#save({ ...state, status: "paused" });
        return "stopped";
      }
      await this.#pause(state, false);
      return "paused";
    });
  }

  /** Stops the container and forgets its snapshot for good. */
  destroy(): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (this.#container.running) await this.#container.destroy();
      await this.#storage.deleteAlarm();
      const now = this.#now();
      const { snapshot: _snapshot, ...rest } = state ?? {
        version: 1 as const,
        instance: "standard-1" as const,
        createdAt: now,
        idleDeadline: now,
      };
      await this.#save({ ...rest, status: "destroyed" });
    });
  }

  /**
   * Restores the snapshot with a sleeping entrypoint (dxd stays down, no
   * Internet) so Cloudflare restarts its 30-day TTL, and re-snapshots it.
   */
  async #refresh(state: OrbWorkspaceState) {
    const snapshot = state.snapshot;
    if (snapshot === undefined) return;
    this.#container.start({
      containerSnapshot: { id: snapshot.id },
      instance: state.instance,
      enableInternet: false,
      entrypoint: ["sleep", "infinity"],
    });
    try {
      await this.#waitReady("refresh");
      const refreshed = await this.#container.snapshotContainer({
        name: `dx-orb-${this.#sandboxId.slice(0, 16)}`,
      });
      await this.#save({
        ...state,
        snapshot: {
          id: refreshed.id,
          size: refreshed.size,
          refreshedAt: this.#now(),
        },
      });
      orbContainerLogger.info("Orb snapshot refreshed.", {
        event: "orb_container_snapshot_refreshed",
        sandboxId: this.#sandboxId,
        snapshotBytes: refreshed.size,
      });
    } finally {
      if (this.#container.running) await this.#container.destroy();
    }
  }

  /**
   * The heartbeat while running (idle pause), and the snapshot refresh while
   * paused. A failure throws, and Cloudflare retries the alarm.
   */
  alarm(): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (state === undefined || state.status === "destroyed") return;
      const now = this.#now();
      if (this.#container.running) {
        if (
          state.status === "active" &&
          now >= state.idleDeadline &&
          this.#inflight === 0
        ) {
          if ((await this.#pause(state, true)) === "paused") return;
        }
        await this.#schedule(this.#now() + ORB_HEARTBEAT_MS);
        return;
      }
      if (state.status === "active") {
        // Stopped without a pause: the latest snapshot (if any) is what
        // the next wake restores.
        orbContainerLogger.warn("Orb container stopped without a pause.", {
          event: "orb_container_stopped_unpaused",
          sandboxId: this.#sandboxId,
          snapshot: state.snapshot !== undefined,
        });
        await this.#save({ ...state, status: "paused" });
      }
      const current = (await this.#load()) ?? state;
      if (current.snapshot === undefined) return;
      const due = current.snapshot.refreshedAt + ORB_SNAPSHOT_REFRESH_MS;
      if (now >= due) {
        await this.#refresh(current);
        const refreshed = (await this.#load()) ?? current;
        await this.#schedule(
          (refreshed.snapshot?.refreshedAt ?? now) + ORB_SNAPSHOT_REFRESH_MS,
        );
      } else await this.#schedule(due);
    });
  }

  /**
   * After this object restarts with its container still running, re-arm the
   * inactivity timeout and the heartbeat. It runs beside the object's calls,
   * never blocking them: `status` answers at once, and lifecycle and
   * container operations wait for it at most `RESTART_WAIT_MS`. A failure is
   * logged; the next heartbeat or open re-arms both.
   */
  resumeAfterRestart(): Promise<void> {
    if (!this.#container.running) return Promise.resolve();
    const startedAt = this.#now();
    const restart = this.#resume().then(
      () => {
        orbContainerLogger.info("Orb container re-armed after a restart.", {
          event: "orb_container_restart",
          sandboxId: this.#sandboxId,
          outcome: "resumed",
          durationMs: this.#now() - startedAt,
        });
      },
      (cause: unknown) => {
        orbContainerLogger.error("Orb container restart work failed.", {
          event: "orb_container_restart",
          sandboxId: this.#sandboxId,
          outcome: "error",
          durationMs: this.#now() - startedAt,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    this.#restart = restart;
    void restart.finally(() => {
      if (this.#restart === restart) this.#restart = undefined;
    });
    return restart;
  }

  async #resume() {
    const state = await this.#load();
    await this.#armInactivity(
      Math.max(0, (state?.idleDeadline ?? this.#now()) - this.#now()),
    );
    const alarm = await this.#storage.getAlarm();
    if (alarm === null || alarm > this.#now() + ORB_HEARTBEAT_MS)
      await this.#schedule(this.#now() + ORB_HEARTBEAT_MS);
  }
}
