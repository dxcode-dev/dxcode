import { describe, expect, it, vi } from "vitest";
import {
  ORB_HEARTBEAT_MS,
  ORB_SNAPSHOT_REFRESH_MS,
  OrbContainerController,
  type OrbContainerRuntime,
  type OrbContainerStartOptions,
  type OrbContainerStorage,
} from "./orb-container.js";

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
  const controller = new OrbContainerController({
    container: fake.container,
    storage,
    image: () => "registry.cloudflare.com/account/dx-orb@sha256:abc",
    sandboxId: "a".repeat(64),
    now: () => now,
  });
  return {
    ...fake,
    storage,
    controller,
    advance: (durationMs: number) => {
      now += durationMs;
    },
    now: () => now,
  };
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
        env: { DX_ORB_HOSTNAME: "cloudflare" },
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
      env: { DX_ORB_HOSTNAME: "cloudflare" },
    });
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
});
