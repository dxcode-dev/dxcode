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
        if (sql.includes("provider = 'cloudflare',")) {
          if (row.state === "uninitialized") {
            row.provider = "cloudflare";
            row.state = "provisioning";
            row.initialization_attempt_id = String(values[0]);
            changes = 1;
          }
        } else if (sql.includes("SET state = 'initialized'")) {
          if (
            row.provider === "cloudflare" &&
            row.state === "provisioning" &&
            row.initialization_attempt_id === values[3]
          ) {
            row.state = "initialized";
            row.provider_sandbox_id = String(values[0]);
            row.initialization_attempt_id = null;
            changes = 1;
          }
        } else if (sql.includes("SET state = 'lost'")) {
          if (row.provider === "cloudflare" && row.state === "initialized") {
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
    expect(stub.open).toHaveBeenCalledWith(
      expect.objectContaining({ create: false }),
    );
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
