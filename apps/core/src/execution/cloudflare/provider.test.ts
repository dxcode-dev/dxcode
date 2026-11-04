import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../plugins/execution/provider.js";
import { classifyRunFailure } from "../../runtime/run-failure.js";

const mocks = vi.hoisted(() => ({
  workerEnv: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.workerEnv }));

const { cloudflareExecutionProvider, CLOUDFLARE_OPEN_TIMEOUT_MS } =
  await import("./provider.js");
const { takeUnsavedStop, unsavedStopNote } = await import(
  "../../orb-disk/unsaved-stop.js"
);
const { OrbContainerController } = await import("./orb-container.js");
const { takeDiskRelief, diskReliefNote } = await import(
  "../../orb-disk/relief.js"
);

const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-0000000000cf",
);

interface Row {
  provider: string;
  state: string;
  provider_sandbox_id: string | null;
  initialization_attempt_id: string | null;
}

/** Just enough D1 for the provider's statements. */
const fakeDatabase = (row: Row, lifecycle = "active") => {
  const prepare = (sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM threads")) return { lifecycle_state: lifecycle };
        return { ...row };
      },
      run: async () => {
        let changes = 0;
        if (sql.includes("SET provider = ?,")) {
          if (row.state === "uninitialized") {
            row.provider = String(values[0]);
            row.state = "provisioning";
            row.initialization_attempt_id = String(values[1]);
            changes = 1;
          }
        } else if (sql.includes("SET state = 'initialized'")) {
          if (
            row.provider === values[3] &&
            row.state === "provisioning" &&
            row.initialization_attempt_id === values[4]
          ) {
            row.state = "initialized";
            row.provider_sandbox_id = String(values[0]);
            row.initialization_attempt_id = null;
            changes = 1;
          }
        } else if (sql.includes("SET state = 'lost'")) {
          if (row.provider === values[2] && row.state === "initialized") {
            row.state = "lost";
            changes = 1;
          }
        }
        return { meta: { changes } };
      },
    }),
  });
  return { prepare } as unknown as D1Database;
};

const fakeNamespace = () => {
  const stub = {
    id: { toString: () => "orb-object-id" },
    open: vi.fn(async () => ({
      kind: "ready" as const,
      sandboxId: "orb-object-id",
      residency: "created" as const,
    })),
    status: vi.fn(async () => ({ running: false, status: "paused" })),
    pause: vi.fn(async () => "paused"),
    destroy: vi.fn(async () => undefined),
    setIdleDeadline: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    })),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stub),
  };
  return { namespace, stub };
};

const context: ExecutionContext = {
  account: { scope: "deployment" },
  credentials: undefined,
  profile: {
    id: "cf.standard-2",
    label: "standard-2",
    adapter: "cloudflare",
    instance: "standard-2",
    resources: { cpuCores: 1, memoryMb: 6144, diskGb: 12 },
    isolation: "container",
    availability: "available",
    capabilities: ["git", "pause-resume"],
  } as unknown as ExecutionContext["profile"],
};

const uninitialized = (): Row => ({
  provider: "e2b",
  state: "uninitialized",
  provider_sandbox_id: null,
  initialization_attempt_id: null,
});

const bind = (row: Row, lifecycle?: string) => {
  const { namespace, stub } = fakeNamespace();
  for (const key of Object.keys(mocks.workerEnv)) delete mocks.workerEnv[key];
  Object.assign(mocks.workerEnv, {
    DB: fakeDatabase(row, lifecycle),
    ORB_CONTAINER: namespace,
    DX_WORKSPACE_INACTIVITY_MS: "120000",
  });
  return { namespace, stub };
};

describe("Cloudflare Containers Orb provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the Thread's container once and pins provider and sandbox identity", async () => {
    const row = uninitialized();
    const { namespace, stub } = bind(row);
    const authorize = vi.fn(async () => undefined);
    const handle = await cloudflareExecutionProvider.workspace.create(
      context,
      { threadId },
      { authorize },
    );
    expect(namespace.idFromName).toHaveBeenCalledWith(threadId);
    expect(stub.open).toHaveBeenCalledWith({
      create: true,
      instance: "standard-2",
      idleMs: 120_000,
      allowReset: true,
    });
    expect(row).toEqual({
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    });
    expect(authorize).toHaveBeenCalled();
    expect(handle.inactivityMs).toBe(120_000);
    await handle.setIdleDeadline(60_000);
    expect(stub.setIdleDeadline).toHaveBeenCalledWith(60_000);
  });

  it("wakes an existing container by its stored identity, reporting residency first", async () => {
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const { stub } = bind(row);
    const observed: string[] = [];
    stub.open.mockImplementationOnce(async () => {
      observed.push("open");
      return {
        kind: "ready",
        sandboxId: "orb-object-id",
        residency: "created",
      };
    });
    await cloudflareExecutionProvider.workspace.create(
      context,
      { threadId },
      {
        authorize: async () => undefined,
        observeResidency: (residency) => {
          observed.push(residency);
        },
      },
    );
    expect(observed).toEqual(["paused", "open"]);
    // Activation sets the workspace up, so it may start one over.
    expect(stub.open).toHaveBeenCalledWith(
      expect.objectContaining({ create: false, allowReset: true }),
    );
  });

  it("tells the turn when dx stopped the Orb without saving its latest files (#1620)", async () => {
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const { stub } = bind(row);
    const savedAt = Date.parse("2026-11-02T09:33:00Z");
    const stoppedAt = Date.parse("2026-11-03T13:01:00Z");
    stub.open.mockImplementationOnce(
      async () =>
        ({
          kind: "ready",
          sandboxId: "orb-object-id",
          residency: "paused",
          unsavedStop: { stoppedAt, savedAt, failures: 8 },
        }) as never,
    );
    await cloudflareExecutionProvider.workspace.create(
      context,
      { threadId },
      { authorize: async () => undefined },
    );
    const stop = takeUnsavedStop(threadId);
    expect(stop).toEqual({ stoppedAt, savedAt, failures: 8 });
    const note = unsavedStopNote(stop as NonNullable<typeof stop>);
    expect(note).toContain("2026-11-02 09:33 UTC");
    expect(note).toContain("2026-11-03 13:01 UTC");
    expect(note).toContain("later changes were lost");
    // Told once: the next turn starts without it.
    expect(takeUnsavedStop(threadId)).toBeUndefined();
  });

  it("archives an Orb that cannot be saved, restores its last save, and the turn says so, through the real container object (#1620)", async () => {
    // The real Orb container object's logic over a container whose
    // snapshots start failing after one good save; the failure is injected
    // here only, as Cloudflare reports it.
    let now = Date.parse("2026-11-02T09:33:00Z");
    let snapshotsFail = false;
    const written: string[] = [];
    const threadStorage = { put: vi.fn(async () => undefined) };
    const empty = () => new Response("").body;
    const container = {
      running: false,
      start: vi.fn(() => {
        container.running = true;
      }),
      exec: vi.fn(async (argv: string[]) => {
        const script = argv.join(" ");
        const stdout = script.includes("mktemp -d /dev/shm/dx-rescue")
          ? "archive /dev/shm/dx-rescue.Zz9 4 2 1 1 1 4\n"
          : script.includes("/dev/shm/dx-rescue.Zz9/archive.tar.gz")
            ? btoa("\x1f\x8b\x08\x00")
            : "";
        if (script.includes("cat >")) written.push(argv.at(-1) ?? "");
        return {
          stdout: new Response(stdout).body,
          stderr: empty(),
          exitCode: Promise.resolve(0),
          kill: () => undefined,
        };
      }),
      snapshotContainer: vi.fn(async () => {
        if (snapshotsFail)
          throw new Error(
            "The container snapshot could not be completed due to an internal error; try again (reference ID: ef5320d5)",
          );
        return { id: "snapshot-good", size: 1024 };
      }),
      destroy: vi.fn(async () => {
        container.running = false;
      }),
      setInactivityTimeout: vi.fn(async () => undefined),
      interceptOutboundHttp: vi.fn(async () => undefined),
    };
    const values = new Map<string, unknown>();
    let alarm: number | null = null;
    const controller = new OrbContainerController({
      container: container as never,
      storage: {
        get: async <T>(key: string) => structuredClone(values.get(key)) as T,
        put: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value));
        },
        delete: async (key: string) => values.delete(key),
        setAlarm: async (time: number) => {
          alarm = time;
        },
        getAlarm: async () => alarm,
        deleteAlarm: async () => {
          alarm = null;
        },
      },
      image: () => "registry.cloudflare.com/account/dx-orb@sha256:abc",
      sandboxId: "orb-object-id",
      stopNotice: () => ({ fetch: vi.fn() }) as unknown as Fetcher,
      now: () => now,
    });
    const stub = new Proxy(controller, {
      get: (target, key) =>
        key === "id"
          ? { toString: () => "orb-object-id" }
          : typeof Reflect.get(target, key) === "function"
            ? (
                Reflect.get(target, key) as (...args: unknown[]) => unknown
              ).bind(target)
            : Reflect.get(target, key),
    });
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const as = (lifecycle: string) => {
      for (const key of Object.keys(mocks.workerEnv))
        delete mocks.workerEnv[key];
      Object.assign(mocks.workerEnv, {
        DB: fakeDatabase(row, lifecycle),
        ORB_CONTAINER: { idFromName: (name: string) => name, get: () => stub },
        // Thread storage is readable by View-only members and outlives the
        // Orb: the copy, which may hold untracked secrets, never goes there.
        DX_STORAGE: threadStorage,
        DX_WORKSPACE_INACTIVITY_MS: "120000",
      });
    };
    // A good save, then work the Orb can no longer save.
    await controller.open({ create: true, instance: "standard-2", idleMs: 1 });
    await controller.pause();
    now = Date.parse("2026-11-03T13:00:00Z");
    as("active");
    await cloudflareExecutionProvider.workspace.create(
      context,
      { threadId },
      { authorize: async () => undefined },
    );
    expect(takeUnsavedStop(threadId)).toBeUndefined();
    snapshotsFail = true;

    // Archive stops it instead of failing with the container running.
    now = Date.parse("2026-11-03T13:01:00Z");
    as("archived");
    await cloudflareExecutionProvider.workspace.release(
      context,
      { threadId },
      "archive",
    );
    expect(container.running).toBe(false);

    // Restored: the activation restores the last good save and its turn
    // starts with what dx did.
    as("active");
    await cloudflareExecutionProvider.workspace.create(
      context,
      { threadId },
      { authorize: async () => undefined },
    );
    expect(container.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerSnapshot: { id: "snapshot-good" } }),
    );
    const stop = takeUnsavedStop(threadId);
    expect(stop).toMatchObject({
      savedAt: Date.parse("2026-11-02T09:33:00Z"),
      stoppedAt: Date.parse("2026-11-03T13:01:00Z"),
      rescue: { size: 4, changes: 2, commits: 1, checkouts: 1 },
      // The copy is back in the restored Orb (Thread storage has no binding
      // in this test).
      restored: {
        orbPath: expect.stringMatching(
          /^\/home\/user\/dx-recovered\/dx-recovered-.+\.tar\.gz$/,
        ),
      },
    });
    expect(written).toContainEqual(stop?.restored?.orbPath);
    const note = unsavedStopNote(stop as NonNullable<typeof stop>);
    expect(note).toContain(
      `Begin your final reply to the people in the Thread, the text after any tool calls, with this sentence: "dx couldn't save this Orb, so it stopped it at 2026-11-03 13:01 UTC and restarted it from its last save (2026-11-02 09:33 UTC); your unsaved work was copied out first, and I've restored it."`,
    );
    expect(note).toContain("git am");
    expect(stop?.restored).not.toHaveProperty("storageFileId");
    expect(threadStorage.put).not.toHaveBeenCalled();
    // The Orb has it, so the object drops its copy and the stop.
    await expect(controller.readRescue(0)).resolves.toBeUndefined();
  });

  it("says how large the copy was when its untracked files did not fit (#1620)", () => {
    const note = unsavedStopNote({
      stoppedAt: Date.parse("2026-11-03T13:01:00Z"),
      savedAt: Date.parse("2026-11-02T09:33:00Z"),
      failures: 8,
      rescue: {
        size: 1_000,
        chunks: 1,
        changes: 4,
        commits: 2,
        checkouts: 1,
        untracked: false,
        fullBytes: 300 * 1024 * 1024,
      },
      restored: {
        name: "dx-recovered-2026-11-03T13-02-00.tar.gz",
        orbPath:
          "/home/user/dx-recovered/dx-recovered-2026-11-03T13-02-00.tar.gz",
        changes: 4,
        commits: 2,
      },
    });
    expect(note).toContain(
      "with them the copy was 300 MB compressed, over dx's 48 MB limit",
    );
    expect(note).toContain("untracked files changed after the save are lost");
  });

  it("tells the turn which caches dx cleared while the disk ran critically low (#1649)", async () => {
    const { stub } = bind({
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    });
    const relief = {
      at: Date.parse("2026-11-04T03:10:00Z"),
      beforeKiB: 900,
      afterKiB: 812_000,
      paths: ["/home/user/.local/share/pnpm/store", "/home/user/.npm/_cacache"],
    };
    stub.open.mockImplementationOnce(
      async () =>
        ({
          kind: "ready",
          sandboxId: "orb-object-id",
          residency: "running",
          diskRelief: relief,
        }) as never,
    );
    await cloudflareExecutionProvider.workspace.create(
      context,
      { threadId },
      { authorize: async () => undefined },
    );
    const told = takeDiskRelief(threadId);
    expect(told).toEqual(relief);
    const note = diskReliefNote(told as NonNullable<typeof told>);
    expect(note).toContain("~/.local/share/pnpm/store, ~/.npm/_cacache");
    expect(note).toContain("only 1 MB left");
    expect(note).toContain("793 MB free");
    expect(note).toContain("dx deleted nothing else");
    expect(takeDiskRelief(threadId)).toBeUndefined();
  });

  it("starts, claims, and wakes nothing until the Thread's admission passes", async () => {
    // Ways this could fail: the claim or the container start runs beside a
    // refused admission; a wake starts the container before admission ends;
    // a late admission is not awaited before the start.
    const refused = new Error("archived");
    for (const row of [
      uninitialized(),
      {
        provider: "cloudflare",
        state: "provisioning",
        provider_sandbox_id: null,
        initialization_attempt_id: "attempt",
      },
      {
        provider: "cloudflare",
        state: "initialized",
        provider_sandbox_id: "orb-object-id",
        initialization_attempt_id: null,
      },
    ]) {
      const before = { ...row };
      const { stub } = bind(row);
      await expect(
        cloudflareExecutionProvider.workspace.create(
          context,
          { threadId },
          {
            authorize: async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              throw refused;
            },
            observeResidency: () => undefined,
          },
        ),
      ).rejects.toBe(refused);
      expect(stub.open).not.toHaveBeenCalled();
      expect(row).toEqual(before);
    }

    const row = uninitialized();
    const { stub } = bind(row);
    let admitted = false;
    stub.open.mockImplementationOnce(async () => {
      expect(admitted).toBe(true);
      return {
        kind: "ready",
        sandboxId: "orb-object-id",
        residency: "created",
      };
    });
    await cloudflareExecutionProvider.workspace.create(
      context,
      { threadId },
      {
        authorize: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          admitted = true;
        },
      },
    );
    expect(stub.open).toHaveBeenCalledOnce();
    expect(row.state).toBe("initialized");
  });

  it("fails a workspace that lost its files as WORKSPACE_RESET, and lets only activation restart it", async () => {
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const { stub } = bind(row);
    const lost = new Error(
      "Orb container use failed: the workspace stopped before its first pause, and its files are gone",
    );
    const handle = await cloudflareExecutionProvider.workspace.connect(
      context,
      { threadId },
      { authorize: async () => undefined },
    );
    stub.exec.mockRejectedValueOnce(lost);
    const sandbox = await handle.sandbox("/home/user/workspace/repo");
    const cause = await sandbox
      .exec("claude --resume")
      .catch((error: unknown) => error);
    expect(stub.exec).toHaveBeenCalledOnce();
    expect(
      classifyRunFailure({ message: (cause as Error).message }),
    ).toMatchObject({
      class: "platform",
      code: "WORKSPACE_RESET",
      retryable: true,
    });
    // A reconnect never starts an empty container in its place.
    expect(stub.open).toHaveBeenCalledWith(
      expect.objectContaining({ create: false, allowReset: false }),
    );
    stub.open.mockRejectedValueOnce(lost);
    const reconnect = await cloudflareExecutionProvider.workspace
      .connect(context, { threadId }, { authorize: async () => undefined })
      .catch((error: unknown) => error);
    expect(
      classifyRunFailure({ message: (reconnect as Error).message }).code,
    ).toBe("WORKSPACE_RESET");
  });

  it("fails closed for a Thread pinned to another provider or never created", async () => {
    bind({
      provider: "e2b",
      state: "initialized",
      provider_sandbox_id: "e2b-sandbox",
      initialization_attempt_id: null,
    });
    await expect(
      cloudflareExecutionProvider.workspace.create(
        context,
        { threadId },
        { authorize: async () => undefined },
      ),
    ).rejects.toMatchObject({ reason: "other provider" });
    const { stub } = bind(uninitialized());
    await expect(
      cloudflareExecutionProvider.workspace.connect(
        context,
        { threadId },
        { authorize: async () => undefined },
      ),
    ).rejects.toMatchObject({ reason: "not created" });
    expect(stub.open).not.toHaveBeenCalled();
  });

  it("marks the workspace lost when its container object no longer has it", async () => {
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const { stub } = bind(row);
    stub.open.mockResolvedValueOnce({ kind: "destroyed" } as never);
    await expect(
      cloudflareExecutionProvider.workspace.connect(
        context,
        { threadId },
        { authorize: async () => undefined },
      ),
    ).rejects.toMatchObject({ reason: "container destroyed" });
    expect(row.state).toBe("lost");
  });

  it("pauses on archive and destroys for good", async () => {
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const archived = bind(row, "archived");
    await cloudflareExecutionProvider.workspace.release(
      context,
      { threadId },
      "archive",
    );
    expect(archived.stub.pause).toHaveBeenCalledOnce();
    expect(row.state).toBe("initialized");

    const destroyed = bind(row, "archived");
    await cloudflareExecutionProvider.workspace.release(
      context,
      { threadId },
      "destroy",
    );
    expect(destroyed.stub.destroy).toHaveBeenCalledOnce();
    expect(row.state).toBe("lost");
    // Nothing left to destroy.
    await cloudflareExecutionProvider.workspace.release(
      context,
      { threadId },
      "destroy",
    );
    expect(destroyed.stub.destroy).toHaveBeenCalledOnce();

    // An active Thread is never paused by archive.
    const active = bind({ ...row, state: "initialized" }, "active");
    await expect(
      cloudflareExecutionProvider.workspace.release(
        context,
        { threadId },
        "archive",
      ),
    ).rejects.toThrow("Thread is not archived.");
    expect(active.stub.pause).not.toHaveBeenCalled();
  });

  it("replaces a stub whose Durable Object reset and retries an idempotent read", async () => {
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const { namespace, stub } = bind(row);
    const reset = {
      ...stub,
      readFile: vi.fn(async () => {
        throw new Error(
          "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
        );
      }),
    };
    const fresh = {
      ...stub,
      readFile: vi.fn(async () => new TextEncoder().encode("contents")),
    };
    namespace.get.mockReturnValueOnce(reset).mockReturnValue(fresh);
    const handle = await cloudflareExecutionProvider.workspace.connect(
      context,
      { threadId },
      { authorize: async () => undefined },
    );
    const sandbox = await handle.sandbox("/workspace");
    await expect(sandbox.readFile("/workspace/a.txt")).resolves.toBe(
      "contents",
    );
    expect(reset.readFile).toHaveBeenCalledOnce();
    expect(fresh.readFile).toHaveBeenCalledOnce();
  });

  it("never replays a command whose object reset, and stamps it a platform failure", async () => {
    const row: Row = {
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
      initialization_attempt_id: null,
    };
    const { stub } = bind(row);
    stub.exec.mockRejectedValueOnce(
      new Error("Durable Object storage is no longer accessible."),
    );
    const handle = await cloudflareExecutionProvider.workspace.connect(
      context,
      { threadId },
      { authorize: async () => undefined },
    );
    const cause = await handle.guest.commands
      .run("make", { timeoutMs: 1_000 })
      .catch((error: unknown) => error);
    expect(stub.exec).toHaveBeenCalledOnce();
    expect(
      classifyRunFailure({ message: (cause as Error).message }),
    ).toMatchObject({ class: "platform", retryable: true });
  });

  it("bounds an open that never returns with a platform failure, reporting its phases", async () => {
    vi.useFakeTimers();
    try {
      const { stub } = bind(uninitialized());
      stub.open.mockImplementation(() => new Promise(() => {}));
      const phases: string[] = [];
      const options = {
        authorize: async () => undefined,
        onPreparationPhase: (phase: string) => {
          phases.push(phase);
        },
      };
      const opened = cloudflareExecutionProvider.workspace
        .create(context, { threadId }, options)
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      await vi.advanceTimersByTimeAsync(CLOUDFLARE_OPEN_TIMEOUT_MS);
      const cause = await opened;
      expect(cause).toBeInstanceOf(Error);
      expect(
        classifyRunFailure({ message: (cause as Error).message }),
      ).toMatchObject({
        class: "platform",
        code: "WORKSPACE_OPEN_TIMED_OUT",
        retryable: true,
      });
      expect(phases[0]).toBe("starting-machine");
      expect(phases).toContain("waiting-for-machine");
    } finally {
      vi.useRealTimers();
    }
  });
});
