import { describe, expect, it, vi } from "vitest";
import { classifyRunFailure } from "../../runtime/run-failure.js";
import {
  ORB_HEARTBEAT_MS,
  ORB_SNAPSHOT_REFRESH_MS,
  ORB_STOP_NOTICE_ADDRESS,
  ORB_WORKSPACE_RESET_DETAIL,
  OrbContainerController,
  type OrbContainerRuntime,
  type OrbContainerStartOptions,
  type OrbContainerStorage,
} from "./orb-container.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}));

const { OrbContainerObject } = await import("./orb-container-object.js");

const encoder = new TextEncoder();

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text !== "") controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

interface ExecCall {
  readonly argv: string[];
  readonly options?: Parameters<OrbContainerRuntime["exec"]>[1];
  readonly stdin?: string;
}

type ExecHandler = (call: ExecCall) => {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
};

const readAll = async (input: ReadableStream | undefined) =>
  input === undefined ? undefined : await new Response(input).text();

const fakeContainer = (handler: ExecHandler = () => ({})) => {
  const starts: OrbContainerStartOptions[] = [];
  const execs: ExecCall[] = [];
  let snapshots = 0;
  const container = {
    running: false as boolean,
    start: vi.fn((options: OrbContainerStartOptions) => {
      if (container.running) throw new Error("already running");
      starts.push(options);
      container.running = true;
    }),
    exec: vi.fn(async (argv: string[], options) => {
      if (!container.running)
        throw new Error(
          "exec() cannot be called on a container that is not running.",
        );
      const call = { argv, options, stdin: await readAll(options?.stdin) };
      execs.push(call);
      const result = argv[0] === "true" ? {} : handler(call);
      return {
        stdout: stream(result.stdout ?? ""),
        stderr: stream(result.stderr ?? ""),
        exitCode: Promise.resolve(result.exitCode ?? 0),
        kill: vi.fn(),
      };
    }),
    snapshotContainer: vi.fn(async () => {
      snapshots += 1;
      return { id: `snapshot-${snapshots}`, size: 1024 * snapshots };
    }),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    setInactivityTimeout: vi.fn(async () => undefined),
    interceptOutboundHttp: vi.fn(async () => undefined),
  } satisfies OrbContainerRuntime & { running: boolean };
  return { container, starts, execs };
};

const fakeStorage = () => {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: OrbContainerStorage & { readonly alarm: () => number | null } =
    {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T,
      put: async (key, value) => {
        values.set(key, structuredClone(value));
      },
      delete: async (key) => values.delete(key),
      setAlarm: async (time) => {
        alarm = time;
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
      },
      alarm: () => alarm,
    };
  return storage;
};

const setup = (handler?: ExecHandler) => {
  let now = 1_000_000;
  const fake = fakeContainer(handler);
  const storage = fakeStorage();
  const stopNotice = { fetch: vi.fn() } as unknown as Fetcher;
  const controller = new OrbContainerController({
    container: fake.container,
    storage,
    image: () => "registry.cloudflare.com/account/dx-orb@sha256:abc",
    sandboxId: "a".repeat(64),
    stopNotice: () => stopNotice,
    now: () => now,
  });
  return {
    ...fake,
    storage,
    controller,
    stopNotice,
    advance: (durationMs: number) => {
      now += durationMs;
    },
    now: () => now,
  };
};

// dx-orb-init sets the short host name for the prompt, and posts the stop
// notice to the address the object intercepts.
const ORB_START_ENVIRONMENT = {
  DX_ORB_HOSTNAME: "cloudflare",
  DX_ORB_STOP_NOTICE: "http://192.0.2.1:80/stopping",
};

const create = {
  create: true,
  instance: "standard-2",
  idleMs: 300_000,
} as const;

describe("Orb container object", () => {
  it("creates a workspace from the image once and pins its instance type", async () => {
    const orb = setup();
    const createdAt = orb.now();
    await expect(orb.controller.open(create)).resolves.toEqual({
      kind: "ready",
      sandboxId: "a".repeat(64),
      residency: "created",
      processesStartedAt: createdAt,
    });
    expect(orb.starts).toEqual([
      {
        image: "registry.cloudflare.com/account/dx-orb@sha256:abc",
        instance: "standard-2",
        enableInternet: true,
        // dx-orb-init sets this short host name for the prompt.
        env: ORB_START_ENVIRONMENT,
      },
    ]);
    // Cloudflare must never stop it before this object snapshots it.
    expect(orb.container.setInactivityTimeout).toHaveBeenCalledWith(
      300_000 + 15 * 60_000,
    );
    expect(orb.storage.alarm()).toBe(orb.now() + ORB_HEARTBEAT_MS);
    // A running workspace is only reconnected.
    await expect(
      orb.controller.open({ ...create, create: false, instance: "standard-4" }),
    ).resolves.toMatchObject({
      residency: "running",
      processesStartedAt: createdAt,
    });
    expect(orb.starts).toHaveLength(1);
    // Connect never creates.
    const empty = setup();
    await expect(
      empty.controller.open({ ...create, create: false }),
    ).resolves.toEqual({ kind: "missing" });
    expect(empty.starts).toEqual([]);
  });

  it("pauses at the idle deadline by snapshot and stop, and wakes from the snapshot", async () => {
    const orb = setup();
    await orb.controller.open(create);
    orb.advance(ORB_HEARTBEAT_MS);
    await orb.controller.alarm();
    // Before the deadline the alarm is only a heartbeat.
    expect(orb.container.snapshotContainer).not.toHaveBeenCalled();
    expect(orb.storage.alarm()).toBe(orb.now() + ORB_HEARTBEAT_MS);

    await orb.controller.setIdleDeadline(60_000);
    orb.advance(60_000);
    await orb.controller.alarm();
    expect(orb.container.snapshotContainer).toHaveBeenCalledOnce();
    expect(orb.container.destroy).toHaveBeenCalledOnce();
    expect(orb.container.running).toBe(false);
    await expect(orb.controller.status()).resolves.toEqual({
      running: false,
      status: "paused",
    });
    // The paused workspace's next alarm refreshes its snapshot's TTL.
    expect(orb.storage.alarm()).toBe(orb.now() + ORB_SNAPSHOT_REFRESH_MS);

    orb.advance(5_000);
    const wokenAt = orb.now();
    // Its processes (and Terminal shells) are new: Core replaces the shell.
    await expect(
      orb.controller.open({ ...create, create: false, instance: "standard-4" }),
    ).resolves.toMatchObject({
      residency: "paused",
      processesStartedAt: wokenAt,
    });
    // Restored from the snapshot, with the instance it was created with.
    expect(orb.starts[1]).toEqual({
      containerSnapshot: { id: "snapshot-1" },
      instance: "standard-2",
      enableInternet: true,
      env: ORB_START_ENVIRONMENT,
    });
  });

  it("backs off idle-pause snapshots that keep failing instead of retrying every heartbeat", async () => {
    // thr_cf588b7a's Orb: 430+ failed snapshots in 16 hours, one per alarm.
    const orb = setup();
    await orb.controller.open(create);
    await orb.controller.setIdleDeadline(60_000);
    const attemptsAt: number[] = [];
    orb.container.snapshotContainer.mockImplementation(async () => {
      attemptsAt.push(orb.now());
      throw new Error(
        "The container snapshot could not be completed due to an internal error; try again (reference ID: 5656a1e5)",
      );
    });
    const startedAt = orb.now();
    // Sixteen hours of heartbeats: a failed snapshot never fails the alarm.
    while (orb.now() < startedAt + 16 * 3_600_000) {
      orb.advance(ORB_HEARTBEAT_MS);
      await expect(orb.controller.alarm()).resolves.toBeUndefined();
    }
    const gaps = attemptsAt
      .slice(1)
      .map((at, index) => at - (attemptsAt[index] ?? 0));
    expect(gaps.slice(0, 4)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(Math.max(...gaps)).toBe(3_600_000);
    expect(attemptsAt.length).toBeLessThan(30);
    // The container keeps running: its files are never dropped.
    expect(orb.container.running).toBe(true);
    expect(orb.container.destroy).not.toHaveBeenCalled();

    // A snapshot that works again pauses it and clears the failures.
    orb.container.snapshotContainer.mockImplementation(async () => ({
      id: "snapshot-late",
      size: 1,
    }));
    orb.advance(3_600_000);
    await orb.controller.alarm();
    expect(orb.container.running).toBe(false);
    await expect(orb.controller.status()).resolves.toEqual({
      running: false,
      status: "paused",
    });
  });

  it("stops a container whose idle snapshots keep failing on its last good save, and says so at the next activation (#1620)", async () => {
    // thr_43b94def's Orb: 29 failed snapshots over 23 hours, never stopped.
    const orb = setup();
    await orb.controller.open(create);
    await orb.controller.pause();
    const savedAt = orb.now();
    orb.advance(60_000);
    await orb.controller.open({ ...create, create: false });
    await orb.controller.setIdleDeadline(60_000);
    let attempts = 0;
    orb.container.snapshotContainer.mockImplementation(async () => {
      attempts += 1;
      throw new Error(
        "The container snapshot could not be completed due to an internal error; try again (reference ID: ef5320d5)",
      );
    });
    const startedAt = orb.now();
    const stopsBefore = orb.container.destroy.mock.calls.length;
    let stoppedAt: number | undefined;
    while (orb.now() < startedAt + 16 * 3_600_000) {
      orb.advance(ORB_HEARTBEAT_MS);
      await expect(orb.controller.alarm()).resolves.toBeUndefined();
      if (stoppedAt === undefined && !orb.container.running)
        stoppedAt = orb.now();
    }
    // Stopped within a few hours, not left running.
    expect(orb.container.running).toBe(false);
    expect(orb.container.destroy.mock.calls.length - stopsBefore).toBe(1);
    expect((stoppedAt ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(
      3 * 3_600_000,
    );
    expect(attempts).toBeLessThanOrEqual(10);
    await expect(orb.controller.status()).resolves.toEqual({
      running: false,
      status: "paused",
    });
    // A Terminal reconnect restores the last good save and keeps the news
    // for the run that tells the agent.
    await expect(
      orb.controller.open({ ...create, create: false, allowReset: false }),
    ).resolves.not.toHaveProperty("unsavedStop");
    expect(orb.starts.at(-1)).toMatchObject({
      containerSnapshot: { id: "snapshot-1" },
    });
    orb.container.snapshotContainer.mockImplementation(async () => ({
      id: "snapshot-fixed",
      size: 1,
    }));
    await orb.controller.pause();
    // The next activation restores and says what happened, once.
    const activation = { ...create, allowReset: true } as const;
    const opened = await orb.controller.open(activation);
    expect(opened).toMatchObject({
      kind: "ready",
      unsavedStop: { savedAt, failures: attempts },
    });
    await expect(orb.controller.open(activation)).resolves.not.toHaveProperty(
      "unsavedStop",
    );
  });

  it("archives a container whose snapshot fails by stopping it on its last good save, and says so (#1620)", async () => {
    const orb = setup();
    await orb.controller.open(create);
    await orb.controller.pause();
    const savedAt = orb.now();
    orb.advance(60_000);
    await orb.controller.open(create);
    orb.container.snapshotContainer.mockRejectedValue(
      new Error(
        "The container snapshot could not be completed due to an internal error; try again (reference ID: b4089c47)",
      ),
    );
    await expect(orb.controller.pause()).resolves.toBe("stopped");
    expect(orb.container.running).toBe(false);
    await expect(orb.controller.status()).resolves.toEqual({
      running: false,
      status: "paused",
    });
    await expect(
      orb.controller.open({ ...create, allowReset: true }),
    ).resolves.toMatchObject({ unsavedStop: { savedAt } });
    expect(orb.starts.at(-1)).toMatchObject({
      containerSnapshot: { id: "snapshot-1" },
    });
  });

  it("copies every checkout's unsaved work out before it stops an Orb it cannot save, and keeps it until Core has it (#1620)", async () => {
    // The owner's ask: a person's latest work must be recoverable.
    const archive = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
    let base64 = "";
    for (const byte of archive) base64 += String.fromCharCode(byte);
    const orb = setup(({ argv }) => {
      const script = argv.join(" ");
      if (script.includes("mktemp -d /dev/shm/dx-rescue"))
        return {
          stdout: `archive /dev/shm/dx-rescue.Ab12 ${String(archive.length)} 3 1 2 1 ${String(archive.length)}\n`,
        };
      if (script.includes("/dev/shm/dx-rescue.Ab12/archive.tar.gz"))
        return { stdout: btoa(base64) };
      return {};
    });
    await orb.controller.open(create);
    await orb.controller.pause();
    await orb.controller.open(create);
    orb.container.snapshotContainer.mockRejectedValue(new Error("internal"));
    const destroysBefore = orb.container.destroy.mock.calls.length;
    await expect(orb.controller.pause()).resolves.toBe("stopped");
    // Copied while the container still ran, then stopped; /dev/shm cleaned.
    const scripts = orb.execs.map(({ argv }) => argv.join(" "));
    expect(scripts.some((script) => script.includes("dx-rescue"))).toBe(true);
    expect(
      scripts.some((script) =>
        script.includes("rm -rf -- /dev/shm/dx-rescue.Ab12"),
      ),
    ).toBe(true);
    expect(orb.container.destroy.mock.calls.length - destroysBefore).toBe(1);

    const activation = { ...create, allowReset: true } as const;
    await expect(orb.controller.open(activation)).resolves.toMatchObject({
      unsavedStop: {
        rescue: {
          size: archive.length,
          chunks: 1,
          changes: 3,
          commits: 1,
          checkouts: 2,
          untracked: true,
        },
      },
    });
    await expect(orb.controller.readRescue(0)).resolves.toEqual(archive);
    // Until Core stores it, the next activation is told again.
    await expect(orb.controller.open(activation)).resolves.toHaveProperty(
      "unsavedStop",
    );
    await orb.controller.clearRescue();
    await expect(orb.controller.readRescue(0)).resolves.toBeUndefined();
    await expect(orb.controller.open(activation)).resolves.not.toHaveProperty(
      "unsavedStop",
    );
  });

  it("says the work is lost when the copy fails, instead of claiming it was kept (#1620)", async () => {
    const orb = setup(({ argv }) =>
      argv.join(" ").includes("dx-rescue")
        ? { stdout: "", stderr: "tar: write error", exitCode: 1 }
        : {},
    );
    await orb.controller.open(create);
    await orb.controller.pause();
    await orb.controller.open(create);
    orb.container.snapshotContainer.mockRejectedValue(new Error("internal"));
    await orb.controller.pause();
    const opened = await orb.controller.open({ ...create, allowReset: true });
    expect(opened).toMatchObject({
      unsavedStop: { rescueFailed: expect.any(String) },
    });
    expect(opened).not.toHaveProperty("unsavedStop.rescue");
  });

  it("still never stops a container that was never saved, since that would lose every file (#1620)", async () => {
    const orb = setup();
    await orb.controller.open(create);
    orb.container.snapshotContainer.mockRejectedValue(new Error("internal"));
    await expect(orb.controller.pause()).rejects.toThrow();
    expect(orb.container.running).toBe(true);
  });

  it("keeps a container running when Core used it while the snapshot ran", async () => {
    const orb = setup();
    await orb.controller.open(create);
    await orb.controller.setIdleDeadline(60_000);
    orb.advance(60_000);
    orb.container.snapshotContainer.mockImplementationOnce(async () => {
      await orb.controller.setIdleDeadline(300_000);
      return { id: "snapshot-late", size: 1 };
    });
    await orb.controller.alarm();
    expect(orb.container.destroy).not.toHaveBeenCalled();
    expect(orb.container.running).toBe(true);
    expect(orb.storage.alarm()).toBe(orb.now() + ORB_HEARTBEAT_MS);
  });

  it("restores a paused container for a command, as E2B resumes on use", async () => {
    const orb = setup(() => ({ stdout: "hello\n" }));
    await orb.controller.open(create);
    await orb.controller.pause();
    expect(orb.container.running).toBe(false);
    await expect(orb.controller.exec("echo hello")).resolves.toEqual({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    expect(orb.starts[1]).toMatchObject({
      containerSnapshot: { id: "snapshot-1" },
    });
  });

  it("archives by snapshot and stop, and destroys for good", async () => {
    const orb = setup();
    await orb.controller.open(create);
    await expect(orb.controller.pause()).resolves.toBe("paused");
    await expect(orb.controller.pause()).resolves.toBe("stopped");
    expect(orb.container.snapshotContainer).toHaveBeenCalledOnce();

    await orb.controller.destroy();
    expect(orb.storage.alarm()).toBeNull();
    await expect(orb.controller.status()).resolves.toEqual({
      running: false,
      status: "destroyed",
    });
    await expect(orb.controller.open(create)).resolves.toEqual({
      kind: "destroyed",
    });
    await expect(orb.controller.exec("true-ish")).rejects.toThrow(
      "the workspace was destroyed",
    );
    expect(orb.starts).toHaveLength(1);
  });

  it("refreshes a paused snapshot before Cloudflare's 30-day expiry without starting dxd", async () => {
    const orb = setup();
    await orb.controller.open(create);
    await orb.controller.pause();
    const due = orb.storage.alarm() ?? 0;
    orb.advance(due - orb.now());
    await orb.controller.alarm();
    expect(orb.starts[1]).toEqual({
      containerSnapshot: { id: "snapshot-1" },
      instance: "standard-2",
      enableInternet: false,
      entrypoint: ["sleep", "infinity"],
    });
    expect(orb.container.snapshotContainer).toHaveBeenCalledTimes(2);
    expect(orb.container.running).toBe(false);
    expect(orb.storage.alarm()).toBe(orb.now() + ORB_SNAPSHOT_REFRESH_MS);
    // The next wake restores the refreshed snapshot.
    await orb.controller.open({ ...create, create: false });
    expect(orb.starts[2]).toMatchObject({
      containerSnapshot: { id: "snapshot-2" },
    });
  });

  it("runs commands as E2B does, with a process-group deadline", async () => {
    const orb = setup(({ argv }) =>
      argv.includes("sleep 99")
        ? { exitCode: 124, stderr: "" }
        : { stdout: "out", stderr: "err", exitCode: 3 },
    );
    await orb.controller.open(create);
    await expect(
      orb.controller.exec("make test", {
        cwd: "/workspace",
        env: { A: "b" },
      }),
    ).resolves.toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 3,
      timedOut: false,
    });
    const call = orb.execs.at(-1);
    expect(call?.argv).toEqual(["bash", "-l", "-c", "make test"]);
    expect(call?.options).toMatchObject({
      cwd: "/workspace",
      env: {
        HOME: "/home/user",
        USER: "user",
        LOGNAME: "user",
        SHELL: "/bin/bash",
        LANG: "C.UTF-8",
        A: "b",
      },
    });

    orb.container.exec.mockImplementationOnce(async (argv: string[]) => {
      orb.execs.push({ argv });
      orb.advance(2_000);
      return {
        stdout: stream(""),
        stderr: stream(""),
        exitCode: Promise.resolve(124),
        kill: vi.fn(),
      };
    });
    await expect(
      orb.controller.exec("sleep 99", { timeoutMs: 1_500 }),
    ).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    expect(orb.execs.at(-1)?.argv).toEqual([
      "timeout",
      "--kill-after=5s",
      "2s",
      "bash",
      "-l",
      "-c",
      "sleep 99",
    ]);
  });

  it("serves files through coreutils in the container", async () => {
    const orb = setup(({ argv, stdin }) => {
      const script = argv[2] ?? "";
      const path = argv[4];
      if (script.includes("cat --") && path === "/missing")
        return { exitCode: 1, stderr: "cat: /missing: No such file\n" };
      if (script.includes("cat --")) return { stdout: "contents" };
      if (script.includes("cat >")) return { stdout: stdin ?? "" };
      if (script.includes("stat -L"))
        return {
          stdout: path === "/link" ? "1\ndirectory" : "0\nregular file",
        };
      if (script.includes("find")) return { stdout: "a\0b c\0" };
      if (script.includes("test -e"))
        return { exitCode: path === "/x" ? 0 : 1 };
      return {};
    });
    await orb.controller.open(create);
    await expect(orb.controller.readFile("/file")).resolves.toEqual(
      encoder.encode("contents"),
    );
    await expect(orb.controller.readFile("/missing")).rejects.toThrow(
      "No such file",
    );
    await orb.controller.writeFile("/new/dir/file", encoder.encode("data"));
    expect(orb.execs.at(-1)).toMatchObject({
      argv: [
        "sh",
        "-c",
        'mkdir -p -- "$(dirname -- "$1")" && exec cat > "$1"',
        "sh",
        "/new/dir/file",
      ],
      stdin: "data",
    });
    await expect(orb.controller.stat("/file")).resolves.toEqual({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    });
    await expect(orb.controller.stat("/link")).resolves.toEqual({
      isFile: false,
      isDirectory: true,
      isSymbolicLink: true,
    });
    await expect(orb.controller.readdir("/dir")).resolves.toEqual(["a", "b c"]);
    await expect(orb.controller.exists("/x")).resolves.toBe(true);
    await expect(orb.controller.exists("/y")).resolves.toBe(false);
    await orb.controller.rm("/tree", { recursive: true, force: true });
    expect(orb.execs.at(-1)?.argv[2]).toBe('exec rm -rf -- "$1"');
  });

  it("re-arms a running container after the object restarts", async () => {
    const orb = setup();
    await orb.controller.open(create);
    await orb.storage.deleteAlarm();
    orb.container.setInactivityTimeout.mockClear();
    const restarted = new OrbContainerController({
      container: orb.container,
      storage: orb.storage,
      image: () => undefined,
      sandboxId: "a".repeat(64),
      now: orb.now,
    });
    await restarted.resumeAfterRestart();
    expect(orb.container.setInactivityTimeout).toHaveBeenCalledOnce();
    expect(orb.storage.alarm()).toBe(orb.now() + ORB_HEARTBEAT_MS);
  });

  it("snapshots on a stop notice, so the next use restores the files instead of losing them", async () => {
    const orb = setup(() => ({ stdout: "still here\n" }));
    await orb.controller.open(create);
    // Every start routes the entrypoint's notice to this object.
    expect(orb.container.interceptOutboundHttp).toHaveBeenCalledWith(
      ORB_STOP_NOTICE_ADDRESS,
      orb.stopNotice,
    );
    // Cloudflare sent SIGTERM before the first pause.
    await expect(orb.controller.stopping()).resolves.toBe("snapshotted");
    expect(orb.container.running).toBe(true);
    // The entrypoint exits once answered; the container stops.
    orb.container.running = false;
    await expect(orb.controller.exec("cat notes")).resolves.toMatchObject({
      stdout: "still here\n",
    });
    expect(orb.starts[1]).toMatchObject({
      containerSnapshot: { id: "snapshot-1" },
    });
    expect(orb.container.interceptOutboundHttp).toHaveBeenCalledTimes(2);
  });

  it("ignores the stop notice its own pause causes", async () => {
    const orb = setup();
    await orb.controller.open(create);
    let notice: Promise<string> | undefined;
    orb.container.destroy.mockImplementationOnce(async () => {
      // The container's SIGTERM reaches the entrypoint while it stops.
      notice = orb.controller.stopping();
      orb.container.running = false;
    });
    await orb.controller.pause();
    await expect(notice).resolves.toBe("ignored");
    expect(orb.container.snapshotContainer).toHaveBeenCalledOnce();
  });

  it("never runs anything on the empty container that replaces one stopped before its first pause", async () => {
    const orb = setup();
    await orb.controller.open(create);
    // Stopped without a stop notice (a crash, a lost host): no snapshot.
    orb.container.running = false;
    const used = await orb.controller
      .exec("ls ~/workspace/repo")
      .catch((error: unknown) => error);
    expect((used as Error).message).toContain(ORB_WORKSPACE_RESET_DETAIL);
    await expect(orb.controller.readFile("/home/user/a")).rejects.toThrow(
      ORB_WORKSPACE_RESET_DETAIL,
    );
    // A reconnect (a Terminal, a run reading its output) cannot start it.
    await expect(
      orb.controller.open({ ...create, create: false, allowReset: false }),
    ).rejects.toThrow(ORB_WORKSPACE_RESET_DETAIL);
    expect(orb.starts).toHaveLength(1);
    // Activation, which sets it up again, starts it over from the image.
    await expect(
      orb.controller.open({ ...create, create: false, allowReset: true }),
    ).resolves.toMatchObject({ kind: "ready", residency: "created" });
    expect(orb.starts[1]).toMatchObject({ image: expect.any(String) });
    await expect(orb.controller.exec("true")).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it("recovers a read-only workspace by snapshot and restart, keeping its files", async () => {
    const orb = setup();
    await orb.controller.open(create);
    orb.advance(60_000);
    await expect(orb.controller.recover()).resolves.toEqual({
      files: "kept",
      savedAt: orb.now(),
    });
    expect(orb.container.running).toBe(false);
    // The next activation starts a new container from that snapshot, whose
    // filesystem Cloudflare mounts afresh.
    await expect(
      orb.controller.open({ ...create, create: false, allowReset: true }),
    ).resolves.toMatchObject({ kind: "ready", residency: "paused" });
    expect(orb.starts[1]).toMatchObject({
      containerSnapshot: { id: "snapshot-1" },
    });
  });

  it("recovers from the last good snapshot when a broken filesystem cannot be snapshotted", async () => {
    const orb = setup();
    await orb.controller.open(create);
    await orb.controller.pause();
    const savedAt = orb.now();
    await orb.controller.open({ ...create, create: false });
    orb.advance(3_600_000);
    // thr_cf588b7a's Orb: every snapshot of its read-only disk failed.
    orb.container.snapshotContainer.mockRejectedValueOnce(
      new Error(
        "The container snapshot could not be completed due to an internal error; try again (reference ID: 5656a1e5)",
      ),
    );
    await expect(
      orb.controller.recover({ discardUnsaved: true }),
    ).resolves.toEqual({
      files: "earlier",
      savedAt,
    });
    expect(orb.container.running).toBe(false);
    await orb.controller.open({ ...create, create: false, allowReset: true });
    expect(orb.starts.at(-1)).toMatchObject({
      containerSnapshot: { id: "snapshot-1" },
    });
  });

  it("starts a read-only workspace that was never saved over from the image, only for activation", async () => {
    const orb = setup();
    await orb.controller.open(create);
    orb.container.snapshotContainer.mockRejectedValueOnce(
      new Error(
        "The container snapshot could not be completed due to an internal error; try again (reference ID: 8b81f4c1)",
      ),
    );
    // Without Core's copy of the unsaved work, nothing is dropped.
    await expect(orb.controller.recover()).resolves.toEqual({
      files: "unsaved",
    });
    expect(orb.container.running).toBe(true);
    orb.container.snapshotContainer.mockRejectedValueOnce(
      new Error(
        "The container snapshot could not be completed due to an internal error; try again (reference ID: 8b81f4c1)",
      ),
    );
    await expect(
      orb.controller.recover({ discardUnsaved: true }),
    ).resolves.toEqual({ files: "lost" });
    expect(orb.container.running).toBe(false);
    // A Terminal or a reconnect never gets the empty container.
    await expect(
      orb.controller.open({ ...create, create: false, allowReset: false }),
    ).rejects.toThrow(ORB_WORKSPACE_RESET_DETAIL);
    await expect(
      orb.controller.open({ ...create, create: false, allowReset: true }),
    ).resolves.toMatchObject({ kind: "ready", residency: "created" });
    expect(orb.starts.at(-1)).toMatchObject({ image: expect.any(String) });
  });

  it("marks a container Cloudflare stopped without a pause as paused", async () => {
    const orb = setup();
    await orb.controller.open(create);
    await orb.controller.pause();
    await orb.controller.open({ ...create, create: false });
    // Stopped behind its back (a crash): the last snapshot is what remains.
    orb.container.running = false;
    await orb.controller.alarm();
    await expect(orb.controller.status()).resolves.toEqual({
      running: false,
      status: "paused",
    });
    expect(orb.storage.alarm()).toBe(orb.now() + ORB_SNAPSHOT_REFRESH_MS);
  });

  it("answers status at once while a restarted object's first storage read stalls 35 s", async () => {
    vi.useFakeTimers();
    try {
      const { container } = fakeContainer();
      container.running = true;
      const storage = fakeStorage();
      await storage.put("workspace", {
        version: 1,
        instance: "standard-2",
        createdAt: 0,
        status: "active",
        idleDeadline: Date.now() + 300_000,
      });
      let reads = 0;
      const stalling: OrbContainerStorage = {
        ...storage,
        get: <T>(key: string) => {
          reads += 1;
          if (reads > 1) return storage.get<T>(key);
          return new Promise<T | undefined>((resolve) =>
            setTimeout(() => resolve(storage.get<T>(key)), 35_000),
          );
        },
      };
      // The runtime's input gate: no call reaches the object while a
      // `blockConcurrencyWhile` callback runs.
      let gate: Promise<unknown> = Promise.resolve();
      const ctx = {
        id: { toString: () => "b".repeat(64) },
        storage: stalling,
        container,
        blockConcurrencyWhile: <A>(callback: () => Promise<A>) => {
          const run = callback();
          gate = run.catch(() => undefined);
          return run;
        },
      };
      const object = new OrbContainerObject(ctx as never, {});
      const deliver = <A>(call: () => Promise<A>) => gate.then(call);
      let answered: unknown;
      void deliver(() => object.status()).then((value) => {
        answered = value;
      });
      let deadlineSet = false;
      void deliver(() => object.setIdleDeadline(60_000)).then(() => {
        deadlineSet = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(answered).toEqual({ running: true, status: "active" });
      // Operations ordered after the restart wait for it, but only so long.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(deadlineSet).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(container.setInactivityTimeout).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a start whose readiness probe hangs at the bound, as a platform failure", async () => {
    vi.useFakeTimers();
    try {
      const { container } = fakeContainer();
      container.exec.mockImplementation(() => new Promise(() => {}));
      const controller = new OrbContainerController({
        container,
        storage: fakeStorage(),
        image: () => "registry.cloudflare.com/account/dx-orb@sha256:abc",
        sandboxId: "c".repeat(64),
      });
      const opened = controller.open(create).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      await vi.advanceTimersByTimeAsync(90_000);
      const cause = await opened;
      expect(cause).toBeInstanceOf(Error);
      expect(
        classifyRunFailure({ message: (cause as Error).message }),
      ).toMatchObject({ class: "platform", retryable: true });
      // The half-started container is stopped, so a retry starts it again.
      expect(container.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
