import type { CloudflareContainerInstance } from "@dx/domain";
import { orbContainerLogger } from "../../logging.js";
import { diskReliefScript, parseDiskRelief } from "../disk-cleanup-script.js";
import {
  parseUnsavedWork,
  UNSAVED_WORK_SCRIPT,
} from "../unsaved-work-script.js";

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
 * - **Stop notice**: Cloudflare may stop a container at any time; before a
 *   planned stop it sends SIGTERM and waits up to 15 minutes. The entrypoint
 *   then posts to `ORB_STOP_NOTICE_ADDRESS`, which this object intercepts,
 *   and the object snapshots the filesystem while the container still runs,
 *   so the next use restores it.
 * - **Reset**: a container that stopped before it ever had a snapshot lost
 *   its files. Commands never run on the empty container that would replace
 *   it: they fail (`stopped before its first pause`), and only Core's
 *   activation, which sets the workspace up again, may start it over from
 *   the image (`open` with `allowReset`).
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
  interceptOutboundHttp(address: string, binding: Fetcher): Promise<void>;
  /** HTTPS on port 443 to `address` (`*`: every host). */
  interceptOutboundHttps(address: string, binding: Fetcher): Promise<void>;
  /** HTTP on port 80 to any host. */
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
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
  delete(key: string): Promise<boolean>;
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
    /** When its files were saved; a refresh keeps it. Unset before 2026-11. */
    readonly takenAt?: number;
  };
  /** Pause after this time unless Core renews it. */
  readonly idleDeadline: number;
  /**
   * Idle-pause snapshots that failed in a row, and when the next may run.
   * A snapshot of a broken filesystem fails every time, so they back off
   * instead of running on every heartbeat; the container keeps running so
   * its files are never dropped. Cleared by any snapshot that works.
   */
  readonly snapshotFailures?: {
    readonly count: number;
    readonly retryAt: number;
  };
  /**
   * The container was stopped without a snapshot of its latest files,
   * because snapshots kept failing (#1620): the next restore starts from the
   * last good save, and the next activation says so. Cleared once told.
   */
  readonly unsavedStop?: UnsavedStop;
  /** Pieces of a rescue archive still stored, until Core clears them. */
  readonly rescueChunks?: number;
  /** The latest caches the heartbeat cleared, until an activation tells. */
  readonly diskRelief?: DiskRelief;
  /**
   * When the running container last started (a create, a wake, or a
   * restart); every process in it, Terminal shells included, is younger.
   */
  readonly startedAt?: number;
  /**
   * A start began at this time and has not answered yet. The next open or
   * command waits for it, even after this object restarts, and never starts
   * another while Cloudflare still runs it.
   */
  readonly starting?: number;
  /**
   * This object's place in the Thread's line of container objects: unset
   * (0) for the first, which Core names by the Thread; each later one took
   * over the snapshot from one whose wake stalled (#1956).
   */
  readonly generation?: number;
  /**
   * Its wake stalled and it handed its snapshot to the next object: it
   * never starts again, runs nothing, and only waits for Cloudflare to
   * stop the stalled container.
   */
  readonly retired?: { readonly at: number; readonly waitedMs: number };
  /**
   * An archive asked for a stop this object could not finish yet (#1740):
   * the alarm tries again, snapshot first, until `ORB_STOP_TRIES` or
   * `ORB_STOP_GIVE_UP_MS`, then logs `orb_stop_abandoned`.
   */
  readonly pendingStop?: PendingStop;
}

/** An archive's stop the alarm still owes; see `pendingStop`. */
export interface PendingStop {
  /** When the archive asked. An open asked for later cancels it. */
  readonly since: number;
  /** Stops tried so far; the archive's own counts. */
  readonly tries: number;
  readonly retryAt: number;
  /** For the logs: the object knows only its sandbox ID. */
  readonly threadId?: string;
}

/** What archive's `pause` did. */
export type OrbArchiveStop = "paused" | "stopped" | "stopping";

/**
 * Caches dx cleared while the disk ran critically low between commands
 * (#1649), for the next activation to tell the person.
 */
export interface DiskRelief {
  readonly at: number;
  readonly beforeKiB: number;
  readonly afterKiB: number;
  readonly paths: ReadonlyArray<string>;
}

/** A stop that kept only the last good save, for the person to be told. */
export interface UnsavedStop {
  readonly stoppedAt: number;
  /** When the files it restores to were saved; unset before 2026-11. */
  readonly savedAt?: number;
  /** Snapshots that failed in a row before it stopped. */
  readonly failures: number;
  /**
   * The unsaved work dx copied out before stopping it: every checkout
   * under ~/workspace's uncommitted and unpushed changes and `git status`,
   * with its untracked files unless they did not fit. Read with
   * `readRescue`, then `clearRescue`.
   */
  readonly rescue?: {
    readonly size: number;
    readonly chunks: number;
    readonly changes: number;
    readonly commits: number;
    readonly checkouts: number;
    readonly untracked: boolean;
    /** The copy's size with its untracked files, which did not fit. */
    readonly fullBytes?: number;
  };
  /** Why the copy failed, when it did: those changes are lost. */
  readonly rescueFailed?: string;
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
      /** Only for an activation (`allowReset`), once: see `unsavedStop`. */
      readonly unsavedStop?: UnsavedStop;
      /** Only for an activation, once: caches the heartbeat cleared. */
      readonly diskRelief?: DiskRelief;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "destroyed" }
  /**
   * The wake's restore did not answer within `ORB_START_STALL_MS` (#1956):
   * this object retired, and Core restores the snapshot in a new one.
   */
  | {
      readonly kind: "stalled";
      readonly handover: OrbHandover;
      /** It had already handed over before this call: no new stall. */
      readonly earlier?: true;
    };

/**
 * What a container object whose wake stalled hands the next one, which
 * restores the same snapshot (#1956). Nothing ran in the stalled start, so
 * the snapshot holds the Thread's latest files.
 */
export interface OrbHandover {
  readonly instance: CloudflareContainerInstance;
  readonly createdAt: number;
  readonly idleDeadline: number;
  readonly snapshot: NonNullable<OrbWorkspaceState["snapshot"]>;
  /** The handing object's place in the Thread's line: 0 for the first. */
  readonly generation: number;
}

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
/**
 * Where the entrypoint announces a stop (`DX_ORB_STOP_NOTICE`). A
 * documentation address (TEST-NET-1) that nothing else uses; the object's
 * intercept answers it, never the Internet.
 */
export const ORB_STOP_NOTICE_ADDRESS = "192.0.2.1:80";
/** While the container runs, the alarm fires this often. */
export const ORB_HEARTBEAT_MS = 10_000;
/** Restore and re-snapshot a paused workspace this long after its TTL clock. */
export const ORB_SNAPSHOT_REFRESH_MS = 25 * 24 * 60 * 60 * 1000;
/** After the first failed idle-pause snapshot, wait this long to retry. */
export const ORB_SNAPSHOT_RETRY_MS = 30_000;
/** Failed idle-pause snapshots back off, doubling, up to this. */
export const ORB_SNAPSHOT_RETRY_MAX_MS = 3_600_000;
/**
 * After this many idle-pause snapshots fail in a row (about an hour of
 * backoff), a container with an earlier good save is stopped anyway: a
 * filesystem no snapshot can read (full btrfs metadata, thr_43b94def) would
 * otherwise run, and bill, until someone notices (#1620).
 */
export const ORB_SNAPSHOT_GIVE_UP_FAILURES = 8;
/** An archive's stop that failed is tried again this often (#1740). */
export const ORB_STOP_RETRY_MS = 5 * 60_000;
/** Stops tried, the archive's own included, before one is abandoned. */
export const ORB_STOP_TRIES = 3;
/** However few tries ran, a stop pending this long is abandoned. */
export const ORB_STOP_GIVE_UP_MS = 15 * 60_000;
/**
 * Cloudflare's answer to a snapshot of a container that never started: its
 * start failed, so nothing ran in it and it holds nothing to save (#1777).
 * Only this answer, never a guess from this object's own records, lets a
 * stop skip the snapshot.
 */
export const CONTAINER_NOT_STARTED = "The container has not been started";

const neverStarted = (cause: unknown) =>
  cause instanceof Error && cause.message.trim() === CONTAINER_NOT_STARTED;

/** The state without an archive's pending stop: the stop happened. */
const stopDone = (state: OrbWorkspaceState): OrbWorkspaceState => {
  const { pendingStop: _done, ...rest } = state;
  return rest;
};
/**
 * While the container runs, its free space is read this often, between
 * commands, and caches are cleared when it is critically low (#1649).
 */
export const ORB_DISK_CHECK_MS = 60_000;
const DISK_RELIEF_TIMEOUT_MS = 120_000;
/** One stored piece of a rescue archive (a SQLite value holds 2 MB). */
const RESCUE_CHUNK_BYTES = 1024 * 1024;
/** Raw bytes read back per command: about 5.3 MB of base64 output. */
const RESCUE_READ_MIB = 4;
const RESCUE_TIMEOUT_MS = 120_000;
const rescueKey = (index: number) => `rescue:${String(index)}`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const decodeBase64 = (text: string) => {
  const binary = atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};
/** Cloudflare stops a container this long after its object goes quiet. */
const MAX_CONTAINER_INACTIVITY_MS = 6 * 60 * 60 * 1000;
const CONTAINER_INACTIVITY_MARGIN_MS = 15 * 60 * 1000;
/** How long a snapshot refresh (a background alarm) waits for its start. */
const READY_TIMEOUT_MS = 90_000;
/**
 * How long one open or command waits for a start to answer (#1956).
 * Cloudflare's snapshot restores are sometimes slow: on production in the
 * week to 6 Nov, 2.7% of them took over 12 s, most of those 60 to 90 s, and
 * then worked. Stopping a start that is still restoring does not help:
 * Cloudflare rarely confirms that stop (1 of 21 since 7 Nov), and the
 * container then reads `running` for hours. So a start is never stopped for
 * being slow: a call waits for it up to this long, and the next call waits
 * for the same start again. The web says it is taking longer than usual
 * after 90 s, and offers Retry when a turn's open reaches this limit.
 */
export const ORB_START_LIMIT_MS = 300_000;
/**
 * A wake's restore that has not answered in this long has stalled (#1956),
 * when Core asks for a start-over (`startOver`): the object retires, and
 * Core restores the same snapshot in a new container object. On
 * production a stalled restore never ran a container at all (Cloudflare's
 * instance list showed none), Cloudflare dropped it after 7 to 10 minutes,
 * and a new restore of the same snapshot answered in 2 to 4 s; 95% of
 * healthy wakes answer within 5 s.
 */
export const ORB_START_STALL_MS = 45_000;
/** A retired object asks Cloudflare to stop its stalled container this often. */
const RETIRED_STOP_RETRY_MS = 60_000;
/**
 * A start's container may read as not running for a moment after
 * `start()`; only past this does a stopped container end the wait.
 */
const STOPPED_GRACE_MS = 10_000;
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
/** A start with a stall budget that did not answer within it. */
class StartStalled extends Error {
  constructor(readonly waitedMs: number) {
    super(`Orb container start stalled after ${Math.round(waitedMs / 1000)} s`);
  }
}

/** A readiness wait that ran out, as opposed to a container that stopped. */
const timedOut = (cause: unknown) =>
  cause instanceof Error &&
  /Orb container \w+ timed out after/.test(cause.message);

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
const ORB_START_ENVIRONMENT = {
  DX_ORB_HOSTNAME: "cloudflare",
  DX_ORB_STOP_NOTICE: `http://${ORB_STOP_NOTICE_ADDRESS}/stopping`,
} as const;

const textDecoder = () => new TextDecoder("utf-8", { fatal: false });

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const failure = (operation: string, detail: string) =>
  new Error(`Orb container ${operation} failed: ${detail}`.trim());

/** Core's provider reads this text as `WORKSPACE_RESET`. */
export const ORB_WORKSPACE_RESET_DETAIL =
  "the workspace stopped before its first pause, and its files are gone";

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
  /** Answers the entrypoint's stop notice by calling `stopping`. */
  readonly stopNotice?: () => Fetcher;
  /**
   * Answers every request from a retired object's container with a
   * refusal, so a stalled container that comes up late never reaches Core
   * (#1956).
   */
  readonly retiredEgress?: () => Fetcher;
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
  readonly #stopNotice: (() => Fetcher) | undefined;
  readonly #retiredEgress: (() => Fetcher) | undefined;
  readonly #now: () => number;
  /** This object is stopping the container itself; a stop notice is moot. */
  #stoppingItself = false;
  #state: OrbWorkspaceState | undefined | null = null;
  /** Serializes start, pause, refresh, and destroy. */
  #lifecycle: Promise<unknown> = Promise.resolve();
  #busy = 0;
  #inflight = 0;
  #diskCheckedAt = 0;
  #relieving = false;
  /** The restart work (`resumeAfterRestart`) while it runs. */
  #restart: Promise<void> | undefined;
  /**
   * A start began and has not answered yet: `running` may read true, but
   * nothing can run in it (thr_5b6834e0, whose queued open took it for
   * running). The next open or command waits for it (`#awaitStart`).
   */
  #neverReady = false;

  constructor(input: OrbContainerControllerInput) {
    this.#container = input.container;
    this.#storage = input.storage;
    this.#image = input.image;
    this.#sandboxId = input.sandboxId;
    this.#stopNotice = input.stopNotice;
    this.#retiredEgress = input.retiredEgress;
    this.#now = input.now ?? Date.now;
  }

  /** Stops the container on this object's own account (pause, destroy). */
  async #destroyContainer() {
    this.#stoppingItself = true;
    try {
      await this.#container.destroy();
      // A stop that returned while the container still runs leaves a start
      // that has not answered as it was.
      if (!this.#container.running) this.#neverReady = false;
    } finally {
      this.#stoppingItself = false;
    }
  }

  /**
   * Routes the entrypoint's stop notice to this object. An intercept lasts
   * until the container stops, so every start registers it. Without it a
   * planned stop loses what the last snapshot does not hold, so a failure
   * is logged, never fatal.
   */
  async #watchForStop() {
    if (this.#stopNotice === undefined) return;
    try {
      await this.#container.interceptOutboundHttp(
        ORB_STOP_NOTICE_ADDRESS,
        this.#stopNotice(),
      );
    } catch (cause) {
      orbContainerLogger.warn("Orb container stop notice is not routed.", {
        event: "orb_container_stop_notice",
        sandboxId: this.#sandboxId,
        outcome: "unrouted",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /**
   * A container that is not running and has no snapshot lost its files: it
   * stopped before its first pause. Starting it from the image would hand
   * callers an empty workspace, so only a caller that sets it up again may.
   */
  #refuseReset(state: OrbWorkspaceState, operation: string) {
    if (state.snapshot !== undefined) return;
    orbContainerLogger.warn("Orb container lost its files before a pause.", {
      event: "orb_container_reset",
      sandboxId: this.#sandboxId,
      operation,
      status: state.status,
      ...(state.startedAt === undefined
        ? {}
        : { ranMs: this.#now() - state.startedAt }),
    });
    throw failure(operation, ORB_WORKSPACE_RESET_DETAIL);
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
  async #waitReady(
    operation: string,
    timeoutMs = READY_TIMEOUT_MS,
    /** The whole wait a failure reports, when earlier attempts ran. */
    reportedMs = timeoutMs,
  ) {
    const startedAt = this.#now();
    const deadline = startedAt + timeoutMs;
    let lastFailure: unknown;
    let attempts = 0;
    let attemptStartedAt = startedAt;
    let slowestAttemptMs = 0;
    let stopped = false;
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
            this.#neverReady = false;
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
          // Cloudflare stopped it: waiting longer cannot help, and the next
          // call starts it again (#1956).
          if (
            !this.#container.running &&
            this.#now() - startedAt >= STOPPED_GRACE_MS
          ) {
            stopped = true;
            break;
          }
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
    // Text the run-failure classifier reads as a platform failure, retried:
    // the next call starts the container again.
    if (stopped)
      throw new Error(
        `Orb container is not running: it stopped during its ${operation}`,
      );
    // Text the run-failure classifier reads as a platform failure.
    throw new Error(
      `Orb container ${operation} timed out after ${Math.round(reportedMs / 1000)} s: ${
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
    /** Ends the wait early with `StartStalled` (Core's start-over, #1956). */
    stallMs?: number,
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
      const residency = await this.#startContainer(
        state,
        idleMs,
        fresh,
        now,
        stallMs,
      );
      orbContainerLogger.info("Orb container started.", {
        ...details,
        outcome: "started",
        durationMs: this.#now() - now,
      });
      return residency;
    } catch (cause) {
      if (cause instanceof StartStalled) {
        orbContainerLogger.warn("Orb container start stalled.", {
          ...details,
          outcome: "stalled",
          durationMs: this.#now() - now,
          running: this.#container.running,
        });
        throw cause;
      }
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
    stallMs?: number,
  ): Promise<"paused" | "created"> {
    const options = this.#startOptions(state);
    if (state.snapshot === undefined && !fresh)
      // Stopped before its first pause (a crash, or Cloudflare stopped
      // it): the filesystem is gone, and the image starts it over.
      orbContainerLogger.warn("Orb container restarted without a snapshot.", {
        event: "orb_container_restart_without_snapshot",
        sandboxId: this.#sandboxId,
      });
    this.#neverReady = true;
    await this.#save({ ...state, starting: now });
    this.#container.start(options);
    await this.#waitWithin(stallMs, now);
    await this.#started(state, idleMs, now);
    return state.snapshot === undefined ? "created" : "paused";
  }

  /**
   * Waits for a start that an earlier call began and that has not answered
   * yet, instead of starting another or stopping it (#1956). Under the
   * lifecycle lock.
   */
  async #awaitStart(
    state: OrbWorkspaceState,
    idleMs: number,
    operation: string,
    /** Whether a start from the image may replace it (Core's activation). */
    mayReset: boolean,
    /** Ends the wait early with `StartStalled` (Core's start-over, #1956). */
    stallMs?: number,
  ): Promise<"paused" | "created"> {
    const startedAt = state.starting ?? this.#now();
    // A start that already had a whole limit may never answer: ask
    // Cloudflare to stop it, briefly, and start again if it did. Nothing
    // ran in it, so the same snapshot (or the image) starts over. With a
    // stall budget, Core starts it over in a new container instead.
    if (
      stallMs === undefined &&
      this.#now() - startedAt >= ORB_START_LIMIT_MS &&
      (state.snapshot !== undefined || mayReset)
    ) {
      await this.#stopBriefly();
      if (!this.#container.running) {
        orbContainerLogger.warn("Orb container start is started over.", {
          event: "orb_container_start_over",
          sandboxId: this.#sandboxId,
          operation,
          startedAgoMs: this.#now() - startedAt,
        });
        return await this.#start(state, idleMs, state.snapshot === undefined);
      }
    }
    const details = {
      event: "orb_container_start_awaited",
      sandboxId: this.#sandboxId,
      operation,
      startedAgoMs: this.#now() - startedAt,
    };
    orbContainerLogger.info(
      "Orb container start is still running; waiting for it.",
      details,
    );
    const waitedFrom = this.#now();
    try {
      await this.#waitWithin(stallMs, startedAt);
    } catch (cause) {
      if (cause instanceof StartStalled) throw cause;
      orbContainerLogger.error("Orb container start is still not ready.", {
        ...details,
        outcome: "error",
        durationMs: this.#now() - waitedFrom,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
    orbContainerLogger.info("Orb container start answered.", {
      ...details,
      outcome: "started",
      durationMs: this.#now() - waitedFrom,
    });
    await this.#started(state, idleMs, startedAt);
    return state.snapshot === undefined ? "created" : "paused";
  }

  /**
   * Waits for the start that began at `startedAt`: up to the limit, or,
   * with a stall budget, until `startedAt + stallMs`, after which it throws
   * `StartStalled`. A container that stopped meanwhile still fails as one
   * that is not running, which the next call starts again.
   */
  async #waitWithin(stallMs: number | undefined, startedAt: number) {
    if (stallMs === undefined) {
      await this.#waitReady("start", ORB_START_LIMIT_MS);
      return;
    }
    const left = startedAt + stallMs - this.#now();
    if (left <= 0) throw new StartStalled(this.#now() - startedAt);
    try {
      await this.#waitReady("start", left);
    } catch (cause) {
      if (timedOut(cause)) throw new StartStalled(this.#now() - startedAt);
      throw cause;
    }
  }

  /** A start answered: arm the container, and record it active. */
  async #started(state: OrbWorkspaceState, idleMs: number, startedAt: number) {
    // Recorded first, so a failure arming it never leaves a ready container
    // marked as still starting.
    // An archive may have asked for a stop while this start ran (#1740).
    const { starting: _starting, ...current } = (await this.#load()) ?? state;
    await this.#save({
      ...current,
      status: "active",
      idleDeadline: Math.max(current.idleDeadline, this.#now() + idleMs),
      startedAt,
      ...(current.snapshot === undefined
        ? {}
        : { snapshot: { ...current.snapshot, refreshedAt: startedAt } }),
    });
    await this.#armInactivity(idleMs);
    await this.#watchForStop();
    await this.#schedule(this.#now() + ORB_HEARTBEAT_MS);
  }

  #startOptions(state: OrbWorkspaceState): OrbContainerStartOptions {
    const snapshot = state.snapshot;
    if (snapshot !== undefined)
      return {
        containerSnapshot: { id: snapshot.id },
        instance: state.instance,
        enableInternet: true,
        env: ORB_START_ENVIRONMENT,
      };
    const image = this.#image();
    if (image === undefined)
      throw failure("start", "the Orb image is not configured");
    return {
      image,
      instance: state.instance,
      enableInternet: true,
      env: ORB_START_ENVIRONMENT,
    };
  }

  /** Whether the container runs and its start answered: commands can use it. */
  #usable() {
    return this.#container.running && !this.#neverReady;
  }

  /**
   * A start that has not answered: nothing has run in it, so its files are
   * still the stored snapshot (or the image). Never snapshotted, and never
   * waited on for more than `ABANDON_START_MS` to stop (#1956).
   */
  #unanswered(state: OrbWorkspaceState) {
    return this.#neverReady || state.starting !== undefined;
  }

  /** Stops the container, waiting at most `ABANDON_START_MS` for it. */
  async #stopBriefly() {
    await within(
      this.#destroyContainer().catch(() => undefined),
      ABANDON_START_MS,
    );
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
    /**
     * The caller sets the workspace up again (Core's activation), so one
     * that lost its files may start over from the image. Unset means
     * allowed, as for a Core from before this option.
     */
    readonly allowReset?: boolean;
    /**
     * Core starts a stalled wake over in a new container object (#1956):
     * a wake whose restore has not answered within `ORB_START_STALL_MS`
     * retires this object and answers `stalled` with its snapshot. Unset,
     * as from a Core before it, waits up to `ORB_START_LIMIT_MS`.
     */
    readonly startOver?: boolean;
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
      // Already handed over: Core finishes the move (it repins its record).
      if (state.retired !== undefined && state.snapshot !== undefined)
        return {
          kind: "stalled",
          handover: this.#handover(state),
          earlier: true,
        };
      // Core opens only an active Thread's Orb: one asked for after an
      // archive's stop means the Thread was restored, so the stop is off.
      // An open already waiting when the archive asked leaves it.
      if (
        state.pendingStop !== undefined &&
        requestedAt > state.pendingStop.since
      ) {
        state = stopDone(state);
        await this.#save(state);
      }
      if (this.#usable()) {
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
          ...(await this.#tellUnsavedStop(input.allowReset === true)),
          ...(await this.#tellDiskRelief(input.allowReset === true)),
        };
      }
      // Only a wake (a snapshot to restore) is started over elsewhere.
      const stallMs =
        input.startOver === true && !fresh && state.snapshot !== undefined
          ? ORB_START_STALL_MS
          : undefined;
      let residency: "paused" | "created";
      try {
        if (this.#container.running)
          // Running but not usable: a start that has not answered yet.
          residency = await this.#awaitStart(
            state,
            input.idleMs,
            "open",
            input.allowReset !== false,
            stallMs,
          );
        else {
          if (!fresh && input.allowReset === false)
            this.#refuseReset(state, "open");
          residency = await this.#start(
            state,
            input.idleMs,
            fresh,
            lockWaitMs,
            stallMs,
          );
        }
      } catch (cause) {
        if (!(cause instanceof StartStalled)) throw cause;
        return await this.#retire(state, cause.waitedMs);
      }
      const started = await this.#load();
      return {
        kind: "ready",
        sandboxId: this.#sandboxId,
        residency,
        ...(started?.startedAt === undefined
          ? {}
          : { processesStartedAt: started.startedAt }),
        ...(await this.#tellUnsavedStop(input.allowReset === true)),
        ...(await this.#tellDiskRelief(input.allowReset === true)),
      };
    });
  }

  #handover(state: OrbWorkspaceState): OrbHandover {
    const snapshot = state.snapshot;
    if (snapshot === undefined) throw failure("handover", "no snapshot");
    return {
      instance: state.instance,
      createdAt: state.createdAt,
      idleDeadline: state.idleDeadline,
      snapshot,
      generation: state.generation ?? 0,
    };
  }

  /**
   * Hands a stalled wake's snapshot over (#1956): this object never starts
   * again, its stalled container is cut off from the network, so one that
   * comes up late can never reach Core, and it is stopped as soon as
   * Cloudflare lets it. Under the lifecycle lock.
   */
  async #retire(
    state: OrbWorkspaceState,
    waitedMs: number,
  ): Promise<OrbOpenResult> {
    const now = this.#now();
    const { starting: _starting, ...current } = (await this.#load()) ?? state;
    const retired: OrbWorkspaceState = {
      ...current,
      status: "paused",
      retired: { at: now, waitedMs },
    };
    await this.#save(retired);
    orbContainerLogger.warn(
      "Orb container wake stalled; its snapshot moves to a new container.",
      {
        event: "orb_container_retired",
        sandboxId: this.#sandboxId,
        generation: retired.generation ?? 0,
        waitedMs,
        running: this.#container.running,
        snapshotId: retired.snapshot?.id,
        snapshotAgeMs:
          retired.snapshot === undefined
            ? undefined
            : now - retired.snapshot.refreshedAt,
      },
    );
    await this.#lockOut();
    await this.#schedule(now + RETIRED_STOP_RETRY_MS);
    return { kind: "stalled", handover: this.#handover(retired) };
  }

  /**
   * Cuts the stalled container off from the network and asks Cloudflare to
   * stop it. Each step is bounded and logged, never awaited past
   * `ABANDON_START_MS`: a stalled container may not answer at all.
   */
  async #lockOut() {
    await this.#cutOff();
    void this.#container.destroy().catch(() => undefined);
  }

  /**
   * Routes all of the container's outbound HTTP and HTTPS to the retired
   * egress, which answers 410. Made again while a retired object's container
   * still runs: a cut-off may not land on a container Cloudflare had not
   * placed yet.
   */
  async #cutOff() {
    const egress = this.#retiredEgress?.();
    const step = async (name: string, run: () => Promise<void>) => {
      const outcome = await within(
        run().then(
          () => "ok" as const,
          (cause: unknown) =>
            cause instanceof Error ? cause.message.slice(0, 200) : "failed",
        ),
        ABANDON_START_MS,
      );
      orbContainerLogger.info("Orb container lock-out step.", {
        event: "orb_container_lock_out",
        sandboxId: this.#sandboxId,
        step: name,
        outcome: outcome ?? "timed_out",
      });
    };
    if (egress !== undefined) {
      await step("https", () =>
        this.#container.interceptOutboundHttps("*", egress),
      );
      await step("http", () =>
        this.#container.interceptAllOutboundHttp(egress),
      );
    }
  }

  /**
   * Takes over a snapshot from the Thread's previous container object,
   * whose wake stalled (#1956). The next `open` restores it here. Taking the
   * same handover again changes nothing.
   */
  adopt(handover: OrbHandover): Promise<"adopted" | "conflict"> {
    return this.#exclusive(async () => {
      const generation = handover.generation + 1;
      const state = await this.#load();
      if (state !== undefined)
        return state.generation === generation ? "adopted" : "conflict";
      await this.#save({
        version: 1,
        instance: handover.instance,
        createdAt: handover.createdAt,
        status: "paused",
        idleDeadline: handover.idleDeadline,
        snapshot: handover.snapshot,
        generation,
      });
      // The snapshot's refresh is this object's now, even if nothing opens
      // it: the retired object never refreshes again.
      await this.#schedule(
        handover.snapshot.refreshedAt + ORB_SNAPSHOT_REFRESH_MS,
      );
      orbContainerLogger.info("Orb container took over a stalled wake.", {
        event: "orb_container_adopted",
        sandboxId: this.#sandboxId,
        generation,
        snapshotId: handover.snapshot.id,
      });
      return "adopted";
    });
  }

  /**
   * The unsaved stop, for an activation to tell its agent and person, and
   * cleared; a Terminal reconnect leaves it for the next activation.
   */
  async #tellUnsavedStop(activation: boolean) {
    if (!activation) return {};
    const state = await this.#load();
    const unsavedStop = state?.unsavedStop;
    if (state === undefined || unsavedStop === undefined) return {};
    // A rescue archive keeps the stop until Core has stored the copy
    // (`clearRescue`), so a failed restore is tried again next activation.
    if ((state.rescueChunks ?? 0) === 0) {
      const { unsavedStop: _told, ...rest } = state;
      await this.#save(rest);
    }
    return { unsavedStop };
  }

  /** The caches the heartbeat cleared, for an activation, and forgotten. */
  async #tellDiskRelief(activation: boolean) {
    if (!activation) return {};
    const state = await this.#load();
    const diskRelief = state?.diskRelief;
    if (state === undefined || diskRelief === undefined) return {};
    const { diskRelief: _told, ...rest } = state;
    await this.#save(rest);
    return { diskRelief };
  }

  /**
   * The heartbeat's disk check (#1649), outside the lifecycle lock: a disk
   * whose metadata runs out mid-turn fails every new file, even the agent's
   * own commands, until the next activation's guard. Below the critical
   * line, and only when nothing is installing or building and no agent
   * command is running, it clears the package-manager caches (see
   * disk-cleanup-script.ts). Never throws.
   */
  async #checkDisk() {
    if (this.#relieving) return;
    this.#relieving = true;
    this.#diskCheckedAt = this.#now();
    try {
      const result = await this.#run(["bash", "-c", diskReliefScript()], {
        cwd: "/home/user",
        timeoutMs: DISK_RELIEF_TIMEOUT_MS,
      });
      const relief = parseDiskRelief(textDecoder().decode(result.stdout));
      if (relief === undefined || relief.kind === "ok") return;
      if (relief.kind !== "cleaned") {
        orbContainerLogger.warn("Orb disk is critically low.", {
          event: "orb_container_disk_relief",
          sandboxId: this.#sandboxId,
          outcome: relief.kind === "busy" ? "deferred" : "nothing",
          freeKiB: relief.freeKiB,
          ...(relief.kind === "busy" ? { busy: relief.what } : {}),
        });
        return;
      }
      const record: DiskRelief = {
        at: this.#now(),
        beforeKiB: relief.beforeKiB,
        afterKiB: relief.afterKiB,
        paths: relief.paths,
      };
      await this.#exclusive(async () => {
        const state = await this.#load();
        if (state !== undefined)
          await this.#save({ ...state, diskRelief: record });
      });
      orbContainerLogger.warn(
        "Orb disk was critically low; dx cleared caches.",
        {
          event: "orb_container_disk_relief",
          sandboxId: this.#sandboxId,
          outcome: "cleaned",
          beforeKiB: relief.beforeKiB,
          afterKiB: relief.afterKiB,
          paths: relief.paths.join(" "),
        },
      );
    } catch (cause) {
      orbContainerLogger.warn("Orb disk check failed.", {
        event: "orb_container_disk_relief",
        sandboxId: this.#sandboxId,
        outcome: "error",
        error: cause instanceof Error ? cause.message.slice(0, 300) : "failed",
      });
    } finally {
      this.#relieving = false;
    }
  }

  /**
   * Stops the container without a snapshot of its latest files, keeping its
   * last good save, once snapshots keep failing. Never without a save: that
   * would lose every file. Under the lifecycle lock.
   */
  async #stopUnsaved(
    state: OrbWorkspaceState,
    failures: number,
    cause: unknown,
  ) {
    const snapshot = state.snapshot;
    if (snapshot === undefined) return false;
    // The person's latest work goes first, while the container still runs.
    const rescued = await this.#rescueUnsavedWork();
    await this.#destroyContainer();
    const { snapshotFailures: _failures, ...rest } = stopDone(
      (await this.#load()) ?? state,
    );
    const unsavedStop: UnsavedStop = {
      stoppedAt: this.#now(),
      failures,
      ...(snapshot.takenAt === undefined ? {} : { savedAt: snapshot.takenAt }),
      ...(rescued.kind === "archive"
        ? { rescue: rescued.rescue }
        : rescued.kind === "failed"
          ? { rescueFailed: rescued.reason }
          : {}),
    };
    await this.#save({ ...rest, status: "paused", unsavedStop });
    orbContainerLogger.error(
      "Orb container stopped without saving its latest files.",
      {
        event: "orb_container_stopped_unsaved",
        sandboxId: this.#sandboxId,
        failures,
        savedAt: snapshot.takenAt,
        rescue: rescued.kind,
        ...(rescued.kind === "archive"
          ? {
              rescueBytes: rescued.rescue.size,
              rescueCheckouts: rescued.rescue.checkouts,
            }
          : rescued.kind === "failed"
            ? { rescueError: rescued.reason }
            : {}),
        error: cause instanceof Error ? cause.message : String(cause),
      },
    );
    await this.#schedule(
      Math.max(
        this.#now() + ORB_HEARTBEAT_MS,
        snapshot.refreshedAt + ORB_SNAPSHOT_REFRESH_MS,
      ),
    );
    return true;
  }

  /**
   * Copies every checkout's unsaved work under ~/workspace into this
   * object's storage, through /dev/shm, before a stop that drops it.
   * Never throws: a failure is reported, and the stop goes ahead.
   */
  async #rescueUnsavedWork(): Promise<
    | { readonly kind: "none" }
    | { readonly kind: "failed"; readonly reason: string }
    | {
        readonly kind: "archive";
        readonly rescue: NonNullable<UnsavedStop["rescue"]>;
      }
  > {
    let directory: string | undefined;
    try {
      const built = await this.#run(["bash", "-c", UNSAVED_WORK_SCRIPT], {
        cwd: "/home/user",
        timeoutMs: RESCUE_TIMEOUT_MS,
      });
      const parsed = parseUnsavedWork(textDecoder().decode(built.stdout));
      if (parsed.kind !== "archive") return parsed;
      directory = parsed.directory;
      const bytes = new Uint8Array(parsed.size);
      let offset = 0;
      for (let read = 0; offset < parsed.size; read += 1) {
        const part = await this.#run(
          [
            "sh",
            "-c",
            `dd if=${quote(`${parsed.directory}/archive.tar.gz`)} bs=1M skip=${String(read * RESCUE_READ_MIB)} count=${String(RESCUE_READ_MIB)} status=none | base64 -w0`,
          ],
          { timeoutMs: RESCUE_TIMEOUT_MS },
        );
        const piece = decodeBase64(textDecoder().decode(part.stdout));
        if (piece.byteLength === 0 || offset + piece.byteLength > parsed.size)
          return { kind: "failed", reason: "the copy came back incomplete" };
        bytes.set(piece, offset);
        offset += piece.byteLength;
      }
      await this.#clearRescueChunks();
      const chunks = Math.ceil(bytes.byteLength / RESCUE_CHUNK_BYTES);
      for (let index = 0; index < chunks; index += 1)
        await this.#storage.put(
          rescueKey(index),
          bytes.slice(
            index * RESCUE_CHUNK_BYTES,
            (index + 1) * RESCUE_CHUNK_BYTES,
          ),
        );
      const current = await this.#load();
      if (current !== undefined)
        await this.#save({ ...current, rescueChunks: chunks });
      return {
        kind: "archive",
        rescue: {
          size: bytes.byteLength,
          chunks,
          changes: parsed.changes,
          commits: parsed.commits,
          checkouts: parsed.checkouts,
          untracked: parsed.untracked,
          ...(parsed.fullBytes === undefined
            ? {}
            : { fullBytes: parsed.fullBytes }),
        },
      };
    } catch (cause) {
      return {
        kind: "failed",
        reason: `copying it failed (${
          cause instanceof Error ? cause.message.slice(0, 200) : "unknown error"
        })`,
      };
    } finally {
      if (directory !== undefined)
        await this.#run(["rm", "-rf", "--", directory], {
          timeoutMs: 10_000,
        }).catch(() => undefined);
    }
  }

  async #clearRescueChunks() {
    const state = await this.#load();
    const chunks = state?.rescueChunks ?? 0;
    for (let index = 0; index < chunks; index += 1)
      await this.#storage.delete(rescueKey(index));
    if (state !== undefined && state.rescueChunks !== undefined) {
      const { rescueChunks: _chunks, ...rest } = state;
      await this.#save(rest);
    }
  }

  /** One piece of the rescue archive an unsaved stop kept, for Core. */
  async readRescue(index: number): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    return this.#storage.get<Uint8Array>(rescueKey(index));
  }

  /**
   * Core stored the rescue archive in the Thread: drop this copy, and the
   * stop it belongs to, which the activation has already told.
   */
  clearRescue(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#clearRescueChunks();
      const state = await this.#load();
      if (state?.unsavedStop !== undefined) {
        const { unsavedStop: _told, ...rest } = state;
        await this.#save(rest);
      }
    });
  }

  /** Whether the container runs now; lets Core report a wake before it. */
  async status(): Promise<{
    readonly running: boolean;
    readonly status: OrbWorkspaceState["status"] | "missing";
    /**
     * Its wake stalled and the Thread's Orb moved on (#1956): the generation
     * of the object that took over, `<thread>~<movedTo>`.
     */
    readonly movedTo?: number;
  }> {
    const state = await this.#load();
    if (state?.retired !== undefined)
      return {
        running: false,
        status: state.status,
        movedTo: (state.generation ?? 0) + 1,
      };
    return {
      // A start that has not answered is not running yet: Core announces
      // a wake for it, Retry included (#1956).
      running:
        this.#container.running &&
        !this.#neverReady &&
        state?.starting === undefined &&
        state?.retired === undefined,
      status: state?.status ?? "missing",
    };
  }

  /** Core's idle deadline: pause `durationMs` from now unless renewed. */
  async setIdleDeadline(durationMs: number): Promise<void> {
    await this.#afterRestart();
    const state = await this.#load();
    if (
      state === undefined ||
      state.status === "destroyed" ||
      state.retired !== undefined
    )
      return;
    await this.#save({ ...state, idleDeadline: this.#now() + durationMs });
    if (this.#container.running) await this.#armInactivity(durationMs);
  }

  /**
   * Runs an operation in the running container. A container that paused
   * meanwhile is restored first, as E2B resumes a paused sandbox on use; one
   * that lost its files is not started (see `#refuseReset`).
   */
  async #use<A>(operation: () => Promise<A>): Promise<A> {
    await this.#afterRestart();
    while (true) {
      await this.#idle();
      if (this.#usable()) break;
      await this.#exclusive(async () => {
        if (this.#usable()) return;
        const state = await this.#load();
        if (state === undefined) throw failure("use", "no workspace");
        if (state.status === "destroyed")
          throw failure("use", "the workspace was destroyed");
        // Text the run-failure classifier reads as a platform failure: the
        // next attempt reaches the Thread's new container object.
        if (state.retired !== undefined)
          throw new Error(
            "Orb container is not running: the Thread's Orb moved to a new container",
          );
        const idleMs = Math.max(
          ORB_HEARTBEAT_MS,
          state.idleDeadline - this.#now(),
        );
        // Running but not usable: a start that has not answered yet.
        if (this.#container.running)
          await this.#awaitStart(state, idleMs, "use", false);
        else {
          this.#refuseReset(state, "use");
          await this.#start(state, idleMs);
        }
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
    const { snapshotFailures: _failures, ...current } =
      (await this.#load()) ?? state;
    const next: OrbWorkspaceState = {
      ...current,
      snapshot: {
        id: snapshot.id,
        size: snapshot.size,
        refreshedAt: this.#now(),
        takenAt: this.#now(),
      },
    };
    if (
      keepIfActive &&
      (this.#inflight > 0 || current.idleDeadline > this.#now())
    ) {
      await this.#save(next);
      return "kept" as const;
    }
    await this.#destroyContainer();
    await this.#save({ ...stopDone(next), status: "paused" });
    orbContainerLogger.info("Orb container paused.", {
      event: "orb_container_paused",
      sandboxId: this.#sandboxId,
      snapshotBytes: snapshot.size,
      durationMs: this.#now() - startedAt,
    });
    await this.#schedule(this.#now() + ORB_SNAPSHOT_REFRESH_MS);
    return "paused" as const;
  }

  /**
   * The idle deadline's pause. A failed snapshot is recorded and retried
   * later with backoff, never thrown: a throw makes Cloudflare retry the
   * alarm at once, and the heartbeat tried again every few seconds.
   */
  async #idlePause(state: OrbWorkspaceState, now: number) {
    const failures = state.snapshotFailures;
    if (failures !== undefined && now < failures.retryAt) return "waiting";
    try {
      return await this.#pause(state, true);
    } catch (cause) {
      if (neverStarted(cause)) {
        await this.#stopUnstarted(state, cause);
        return "paused";
      }
      const count = (failures?.count ?? 0) + 1;
      const delayMs = Math.min(
        ORB_SNAPSHOT_RETRY_MS * 2 ** (count - 1),
        ORB_SNAPSHOT_RETRY_MAX_MS,
      );
      const current = (await this.#load()) ?? state;
      if (
        count >= ORB_SNAPSHOT_GIVE_UP_FAILURES &&
        (await this.#stopUnsaved(current, count, cause))
      )
        return "paused";
      await this.#save({
        ...current,
        snapshotFailures: { count, retryAt: this.#now() + delayMs },
      });
      orbContainerLogger.error("Orb container idle snapshot failed.", {
        event: "orb_container_snapshot_failed",
        sandboxId: this.#sandboxId,
        failures: count,
        retryInMs: delayMs,
        hadSnapshot: current.snapshot !== undefined,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return "failed";
    }
  }

  /**
   * Archive: snapshot and stop now, whatever the idle deadline says.
   *
   * - `paused`: snapshotted and stopped.
   * - `stopped`: it was not running; or Cloudflare says it never started,
   *   so it holds nothing to save; or it could not be saved and stopped on
   *   its last good save (#1620).
   * - `stopping`: it could not be stopped without losing files, so it keeps
   *   running, its idle deadline is now, and the alarm tries again, snapshot
   *   first (`pendingStop`). With `defer`, Core's record says a start may
   *   still be running: the stop is left to the alarm, which waits for it,
   *   instead of holding the archive.
   */
  async pause(
    options: { readonly threadId?: string; readonly defer?: boolean } = {},
  ): Promise<OrbArchiveStop> {
    if (options.defer === true) return await this.#deferStop(options.threadId);
    return await this.#exclusive(async () => {
      const state = await this.#load();
      if (state === undefined || state.status === "destroyed") return "stopped";
      const stop = await this.#archiveStop(state);
      if (stop.kind !== "failed") return stop.kind;
      await this.#owePendingStop(state, 1, options.threadId, stop.cause);
      return "stopping";
    });
  }

  /** One try at an archive's stop, under the lifecycle lock. */
  async #archiveStop(
    state: OrbWorkspaceState,
  ): Promise<
    | { readonly kind: "paused" | "stopped" }
    | { readonly kind: "failed"; readonly cause: unknown }
  > {
    if (!this.#container.running) {
      if (state.status === "active" || state.pendingStop !== undefined)
        await this.#save({ ...stopDone(state), status: "paused" });
      return { kind: "stopped" };
    }
    if (state.retired !== undefined) return { kind: "stopped" };
    if (this.#unanswered(state)) {
      await this.#stopUnstarted(state, "its start had not answered");
      return { kind: "stopped" };
    }
    try {
      await this.#pause(state, false);
      return { kind: "paused" };
    } catch (cause) {
      if (neverStarted(cause)) {
        await this.#stopUnstarted(state, cause);
        return { kind: "stopped" };
      }
      try {
        // Archive stops the container even when it cannot be saved now,
        // on its last good save, and the restore says so (#1620).
        const current = (await this.#load()) ?? state;
        const failures = (current.snapshotFailures?.count ?? 0) + 1;
        if (await this.#stopUnsaved(current, failures, cause))
          return { kind: "stopped" };
      } catch (stopCause) {
        return { kind: "failed", cause: stopCause };
      }
      return { kind: "failed", cause };
    }
  }

  /**
   * Stops a container Cloudflare says never started, without a snapshot:
   * nothing ran in it, so it holds nothing newer than its last snapshot (or
   * the image). Under the lifecycle lock.
   */
  async #stopUnstarted(state: OrbWorkspaceState, cause: unknown) {
    await this.#stopBriefly();
    const { snapshotFailures: _failures, ...rest } = stopDone(
      (await this.#load()) ?? state,
    );
    await this.#save({ ...rest, status: "paused" });
    orbContainerLogger.warn(
      "Orb container stopped without a snapshot: it never started.",
      {
        event: "orb_container_stopped_unstarted",
        sandboxId: this.#sandboxId,
        snapshot: rest.snapshot !== undefined,
        error: cause instanceof Error ? cause.message : String(cause),
      },
    );
    if (rest.snapshot !== undefined)
      await this.#schedule(
        Math.max(
          this.#now() + ORB_HEARTBEAT_MS,
          rest.snapshot.refreshedAt + ORB_SNAPSHOT_REFRESH_MS,
        ),
      );
  }

  /**
   * Records an archive's stop for the alarm to try again, with the idle
   * deadline now, so nothing keeps the container for its idle time.
   */
  async #owePendingStop(
    state: OrbWorkspaceState,
    tries: number,
    threadId: string | undefined,
    cause: unknown,
  ) {
    const now = this.#now();
    const current = (await this.#load()) ?? state;
    const pendingStop: PendingStop = {
      since: current.pendingStop?.since ?? now,
      tries,
      retryAt: tries === 0 ? now : now + ORB_STOP_RETRY_MS,
      ...((threadId ?? current.pendingStop?.threadId) === undefined
        ? {}
        : { threadId: threadId ?? current.pendingStop?.threadId }),
    };
    await this.#save({ ...current, idleDeadline: now, pendingStop });
    await this.#schedule(
      tries === 0 ? now : Math.min(pendingStop.retryAt, now + ORB_HEARTBEAT_MS),
    );
    orbContainerLogger.warn("Orb container stop is pending.", {
      event: "orb_container_stop_pending",
      sandboxId: this.#sandboxId,
      ...(pendingStop.threadId === undefined
        ? {}
        : { threadId: pendingStop.threadId }),
      tries,
      retryAt: pendingStop.retryAt,
      ...(cause === undefined
        ? {}
        : { error: cause instanceof Error ? cause.message : String(cause) }),
    });
  }

  /**
   * Archive while Core's record says a start may still run: record the
   * stop without waiting on the lifecycle lock, and let the alarm, which
   * runs under it, do it.
   */
  async #deferStop(threadId: string | undefined): Promise<OrbArchiveStop> {
    await this.#afterRestart();
    const state = await this.#load();
    if (state === undefined || state.status === "destroyed") return "stopped";
    if (
      !this.#container.running &&
      state.status !== "active" &&
      this.#busy === 0
    )
      return "stopped";
    await this.#owePendingStop(state, 0, threadId, undefined);
    return "stopping";
  }

  /**
   * The alarm's turn at an archive's pending stop, under the lifecycle lock
   * with the container running. After the last try the stop is abandoned,
   * at error level, and the idle pause's own retries and logs carry on.
   */
  async #retryPendingStop(state: OrbWorkspaceState, pending: PendingStop) {
    const now = this.#now();
    if (now < pending.retryAt) {
      await this.#schedule(
        Math.min(pending.retryAt, this.#now() + ORB_HEARTBEAT_MS),
      );
      return;
    }
    const stop = await this.#archiveStop(state);
    if (stop.kind !== "failed") return;
    const tries = pending.tries + 1;
    if (tries < ORB_STOP_TRIES && now - pending.since < ORB_STOP_GIVE_UP_MS) {
      await this.#owePendingStop(state, tries, pending.threadId, stop.cause);
      return;
    }
    const current = (await this.#load()) ?? state;
    await this.#save(stopDone(current));
    orbContainerLogger.error("Orb container could not be stopped.", {
      event: "orb_stop_abandoned",
      sandboxId: this.#sandboxId,
      ...(pending.threadId === undefined ? {} : { threadId: pending.threadId }),
      tries,
      pendingMs: now - pending.since,
      hadSnapshot: current.snapshot !== undefined,
      error:
        stop.cause instanceof Error ? stop.cause.message : String(stop.cause),
    });
    await this.#schedule(this.#now() + ORB_HEARTBEAT_MS);
  }

  /**
   * Core found the container's filesystem read-only (a btrfs root forced
   * read-only stays so until it is mounted again). Saves what it can and
   * stops the container; the next activation's open starts a new one, whose
   * filesystem is mounted afresh:
   *
   * - `kept`: a snapshot of it now succeeded, and the new container starts
   *   from it.
   * - `earlier`: the broken filesystem could not be snapshotted, and the
   *   new container starts from the last snapshot.
   * - `lost`: there was none, so only activation may start it over from the
   *   image (see `#refuseReset`).
   *
   * The last two drop work, so they happen only with `discardUnsaved`, once
   * Core has copied that work out; otherwise nothing changes (`unsaved`).
   */
  recover(options: { readonly discardUnsaved?: boolean } = {}): Promise<{
    readonly files: "kept" | "earlier" | "lost" | "unsaved";
    readonly savedAt?: number;
  }> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (state === undefined) throw failure("recover", "no workspace");
      if (state.status === "destroyed")
        throw failure("recover", "the workspace was destroyed");
      if (state.retired !== undefined)
        throw failure("recover", "the Orb moved to a new container");
      const startedAt = this.#now();
      let current = state;
      let files: "kept" | "earlier" | "lost";
      if (this.#container.running && this.#unanswered(state)) {
        // Nothing ran in a start that has not answered: its files are the
        // stored snapshot, and it is never snapshotted (#1956).
        files = state.snapshot === undefined ? "lost" : "kept";
        await this.#stopBriefly();
      } else if (this.#container.running) {
        try {
          const snapshot = await this.#container.snapshotContainer({
            name: `dx-orb-${this.#sandboxId.slice(0, 16)}`,
          });
          current = {
            ...((await this.#load()) ?? state),
            snapshot: {
              id: snapshot.id,
              size: snapshot.size,
              refreshedAt: this.#now(),
              takenAt: this.#now(),
            },
          };
          files = "kept";
        } catch (cause) {
          orbContainerLogger.warn(
            "Orb container snapshot failed before a recovery.",
            {
              event: "orb_container_recover_snapshot",
              sandboxId: this.#sandboxId,
              outcome: "error",
              error: cause instanceof Error ? cause.message : String(cause),
            },
          );
          current = (await this.#load()) ?? state;
          // Core copies the unsaved work out first; without that copy, the
          // container keeps running rather than losing it.
          if (options.discardUnsaved !== true) {
            orbContainerLogger.warn("Orb container left running unsaved.", {
              event: "orb_container_recovered",
              sandboxId: this.#sandboxId,
              files: "unsaved",
            });
            // The last good save, which a restart that drops the unsaved
            // work would start from (#1592).
            return current.snapshot?.takenAt === undefined
              ? { files: "unsaved" as const }
              : {
                  files: "unsaved" as const,
                  savedAt: current.snapshot.takenAt,
                };
          }
          files = current.snapshot === undefined ? "lost" : "earlier";
        }
        await this.#destroyContainer();
      } else files = state.snapshot === undefined ? "lost" : "kept";
      // The next container starts on a fresh filesystem.
      const { snapshotFailures: _failures, ...restarted } = current;
      await this.#save({ ...restarted, status: "paused" });
      orbContainerLogger.info("Orb container stopped for a recovery.", {
        event: "orb_container_recovered",
        sandboxId: this.#sandboxId,
        files,
        durationMs: this.#now() - startedAt,
      });
      return current.snapshot === undefined
        ? { files }
        : current.snapshot.takenAt === undefined
          ? { files }
          : { files, savedAt: current.snapshot.takenAt };
    });
  }

  /** Stops the container and forgets its snapshot for good. */
  destroy(): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (this.#container.running) {
        if (state !== undefined && this.#unanswered(state))
          await this.#stopBriefly();
        else await this.#destroyContainer();
      }
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
          ...(snapshot.takenAt === undefined
            ? {}
            : { takenAt: snapshot.takenAt }),
        },
      });
      orbContainerLogger.info("Orb snapshot refreshed.", {
        event: "orb_container_snapshot_refreshed",
        sandboxId: this.#sandboxId,
        snapshotBytes: refreshed.size,
      });
    } finally {
      // A refresh's restore can stall as a wake's does: never wait on its
      // stop for long, and never hand its sleeping container (no dxd, no
      // Internet) to a wake. A wake treats it as a start that has not
      // answered, and starts over elsewhere (#1956).
      if (this.#container.running) {
        await this.#stopBriefly();
        if (this.#container.running) this.#neverReady = true;
      }
    }
  }

  /**
   * The entrypoint's stop notice: Cloudflare sent SIGTERM and stops the
   * container within 15 minutes. Snapshots the filesystem while it still
   * runs and records it, so the next use restores it instead of losing it.
   * The container stays active; it stops when the entrypoint exits.
   */
  stopping(): Promise<"snapshotted" | "ignored"> {
    if (this.#stoppingItself) return Promise.resolve("ignored");
    const noticedAt = this.#now();
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (
        this.#stoppingItself ||
        !this.#container.running ||
        state === undefined ||
        state.status !== "active"
      )
        return "ignored" as const;
      const details = {
        event: "orb_container_stop_snapshot",
        sandboxId: this.#sandboxId,
        hadSnapshot: state.snapshot !== undefined,
        ...(state.startedAt === undefined
          ? {}
          : { ranMs: noticedAt - state.startedAt }),
      };
      try {
        const snapshot = await this.#container.snapshotContainer({
          name: `dx-orb-${this.#sandboxId.slice(0, 16)}`,
        });
        const current = (await this.#load()) ?? state;
        await this.#save({
          ...current,
          snapshot: {
            id: snapshot.id,
            size: snapshot.size,
            refreshedAt: this.#now(),
            takenAt: this.#now(),
          },
        });
        orbContainerLogger.info("Orb container snapshotted before a stop.", {
          ...details,
          outcome: "snapshotted",
          snapshotBytes: snapshot.size,
          durationMs: this.#now() - noticedAt,
        });
        return "snapshotted" as const;
      } catch (cause) {
        orbContainerLogger.error("Orb container stop snapshot failed.", {
          ...details,
          outcome: "error",
          durationMs: this.#now() - noticedAt,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    });
  }

  /**
   * The heartbeat while running (idle pause), and the snapshot refresh while
   * paused. A failure throws, and Cloudflare retries the alarm.
   */
  async alarm(): Promise<void> {
    let checkDisk = false;
    await this.#exclusive(async () => {
      const state = await this.#load();
      if (state === undefined || state.status === "destroyed") return;
      const now = this.#now();
      if (state.retired !== undefined) {
        await this.#retiredAlarm(state, state.retired, now);
        return;
      }
      if (this.#container.running) {
        if (state.pendingStop !== undefined) {
          await this.#retryPendingStop(state, state.pendingStop);
          return;
        }
        if (
          state.status === "active" &&
          now >= state.idleDeadline &&
          this.#inflight === 0 &&
          !this.#unanswered(state)
        ) {
          if ((await this.#idlePause(state, now)) === "paused") return;
        }
        await this.#schedule(this.#now() + ORB_HEARTBEAT_MS);
        checkDisk =
          state.status === "active" &&
          now - this.#diskCheckedAt >= ORB_DISK_CHECK_MS;
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
        await this.#save({ ...stopDone(state), status: "paused" });
      } else if (state.pendingStop !== undefined)
        await this.#save(stopDone(state));
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
    if (checkDisk && this.#container.running) await this.#checkDisk();
  }

  /**
   * A retired object's alarm: asks Cloudflare to stop the stalled container
   * until it has, then logs how long it lingered and stops its alarms.
   */
  async #retiredAlarm(
    state: OrbWorkspaceState,
    retired: NonNullable<OrbWorkspaceState["retired"]>,
    now: number,
  ) {
    if (this.#container.running) {
      await this.#cutOff();
      await this.#stopBriefly();
      if (this.#container.running) {
        await this.#schedule(now + RETIRED_STOP_RETRY_MS);
        return;
      }
    }
    orbContainerLogger.info("Retired Orb container stopped.", {
      event: "orb_container_retired_stopped",
      sandboxId: this.#sandboxId,
      generation: state.generation ?? 0,
      lingeredMs: now - retired.at,
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
    if (state?.retired !== undefined) {
      // Its stalled container is never used: cut it off again, and keep
      // asking it to stop.
      this.#neverReady = true;
      await this.#cutOff();
      const alarm = await this.#storage.getAlarm();
      if (alarm === null || alarm > this.#now() + RETIRED_STOP_RETRY_MS)
        await this.#schedule(this.#now() + RETIRED_STOP_RETRY_MS);
      return;
    }
    // A start that had not answered before this object restarted.
    if (state?.starting !== undefined) this.#neverReady = true;
    await this.#armInactivity(
      Math.max(0, (state?.idleDeadline ?? this.#now()) - this.#now()),
    );
    // The intercept outlives the object; registering it again routes the
    // notice through this deployment's code.
    await this.#watchForStop();
    const alarm = await this.#storage.getAlarm();
    if (alarm === null || alarm > this.#now() + ORB_HEARTBEAT_MS)
      await this.#schedule(this.#now() + ORB_HEARTBEAT_MS);
  }
}
