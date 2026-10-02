import { ThreadId } from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Effect, Redacted, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executionWorkspaceLogger, threadDaemonLogger } from "../logging.js";
import {
  GITHUB_CLI_WRAPPER_INSTALL_COMMAND,
  githubCliWrapper,
} from "../source-control/github/cli-wrapper.js";
import type { WorkspaceActivity } from "./activity.js";

class TestWorkspaceError extends Schema.TaggedError<TestWorkspaceError>()(
  "TestWorkspaceError",
  { message: Schema.String },
) {}

const mocks = vi.hoisted(() => {
  const firstThreadLifecycle = vi.fn(async () => ({
    lifecycle_state: "active",
  }));
  const firstWorkspaceReadiness = vi.fn(
    async (): Promise<{
      ready_at: string | null;
      preparation_status: string | null;
    }> => ({
      ready_at: "2026-09-15T12:00:00.000Z",
      preparation_status: null,
    }),
  );
  const runThreadLifecycle = vi.fn(async () => ({ meta: { changes: 1 } }));
  const bindThreadLifecycle = vi.fn(() => ({
    first: firstThreadLifecycle,
    run: runThreadLifecycle,
  }));
  const firstSourceWorkspace = vi.fn(async () => ({
    owner_user_id: "user-test",
    snapshot_thread_id: null,
    snapshot_project_id: null,
    snapshot_binding_revision: null,
    snapshot_provider: null,
    snapshot_repository_full_name: null,
    snapshot_clone_url: null,
    snapshot_default_branch: null,
    snapshot_initial_ref: null,
    snapshot_initial_commit_sha: null,
    snapshot_created_at: null,
    intent_thread_id: null,
    intent_project_id: null,
    intent_binding_revision: null,
    intent_provider: null,
    intent_repository_full_name: null,
    intent_clone_url: null,
    intent_created_at: null,
    owner_grant_id: null,
    installation_id: null,
    provider_workspace_id: null,
    provider_repository_id: null,
    authorization_epoch: null,
    installation_epoch: null,
    policy_revision: null,
    private_submodule_repository_ids_json: null,
  }));
  const firstGithubConnection = vi.fn(
    async (): Promise<{ connected: number } | null> => null,
  );
  const prepareThreadLifecycle = vi.fn((sql: string) =>
    sql.includes("SELECT ready_at, preparation_status")
      ? {
          bind: vi.fn(() => ({ first: firstWorkspaceReadiness })),
        }
      : sql.includes("JOIN github_user_authorization a")
        ? { bind: vi.fn(() => ({ first: firstGithubConnection })) }
        : sql.includes("thread_source_snapshot")
          ? {
              bind: vi.fn(() => ({ first: firstSourceWorkspace })),
            }
          : { bind: bindThreadLifecycle },
  );
  const db = { prepare: prepareThreadLifecycle } as unknown as D1Database;
  const workerEnv = { DB: db, DX_RUNTIME_MODE: "deployed" };
  const profile = {
    id: "e2b-test",
    label: "Test workspace",
    adapter: "e2b" as const,
    template: "test-template",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: [
      "git",
      "environment-variables",
      "internet-access",
      "persistent-workspace",
      "pause-resume",
    ] as const,
  };
  return {
    db,
    firstThreadLifecycle,
    firstWorkspaceReadiness,
    firstSourceWorkspace,
    firstGithubConnection,
    bindThreadLifecycle,
    runThreadLifecycle,
    prepareThreadLifecycle,
    workerEnv,
    profile,
    resolveProfile: vi.fn(() => Effect.succeed(profile)),
    loadRequirements: vi.fn((_bindings: unknown, templateOverride?: string) =>
      Effect.succeed({
        apiKey: Redacted.make("test-api-key"),
        dxEnv: "test",
        template: templateOverride ?? profile.template,
        timeoutMs: 60_000,
        inactivityMs: 75_000,
      }),
    ),
    decodeDb: vi.fn(() => Effect.succeed(db)),
    recordRunnerUsage: vi.fn(async () => undefined),
    publishRealtimeInvalidation: vi.fn(async () => undefined),
    publishRealtimeWorkspaceStatus: vi.fn(async () => undefined),
    runnerResourceAttribution: vi.fn(() => ({
      profileId: "e2b-test",
      profileVersion: 1,
      cpuCores: 2,
      memoryMb: 4096,
      diskGb: 20,
    })),
    executeSourcePush: vi.fn(async () => ({ status: "pushed" as const })),
    resolveWorkspace: vi.fn(
      (_options: {
        readonly observeResolution?: (observation: unknown) => void;
        readonly observeResidency?: (
          residency: "running" | "paused" | "unknown",
        ) => void;
      }) =>
        Effect.fail(
          new TestWorkspaceError({
            message: "workspace resolver should not run",
          }),
        ),
    ),
    connectWorkspace: vi.fn(
      (_options: {
        readonly observeResolution?: (observation: unknown) => void;
      }) =>
        Effect.fail(
          new TestWorkspaceError({
            message: "existing workspace resolver should not run",
          }),
        ),
    ),
    makeChangesCoordinator: vi.fn(),
    loadDaemonRelease: vi.fn(async () => ({
      binary: new Uint8Array([1]),
      sha256: "a".repeat(64),
    })),
    loadDaemonReleaseMetadata: vi.fn(async () => ({
      url: "https://release.test/dxd",
      sha256: "a".repeat(64),
    })),
    ensureDaemonInGuest: vi.fn(async () => undefined),
  };
});

vi.mock("cloudflare:workers", () => ({ env: mocks.workerEnv }));
vi.mock("./runner-profiles/execution.js", () => ({
  resolveExecutionRunnerProfile: mocks.resolveProfile,
}));
vi.mock("./e2b/requirements.js", () => ({
  loadE2BRequirements: mocks.loadRequirements,
}));
vi.mock("../persistence/d1-binding.js", () => ({
  decodeD1Binding: mocks.decodeDb,
}));
vi.mock("../settings/usage/recorder.js", () => ({
  recordRunnerUsage: mocks.recordRunnerUsage,
  runnerResourceAttribution: mocks.runnerResourceAttribution,
}));
vi.mock("../realtime/publication.js", () => ({
  publishRealtimeInvalidation: mocks.publishRealtimeInvalidation,
  publishRealtimeWorkspaceStatus: mocks.publishRealtimeWorkspaceStatus,
}));
vi.mock("./e2b/resolver.js", () => ({
  makeD1ExecutionWorkspaceCoordinator: vi.fn(() => ({
    acquire: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  })),
  makeD1ExecutionWorkspaceStateStore: vi.fn(() => ({})),
  connectExistingExecutionWorkspace: mocks.connectWorkspace,
  resolveExecutionWorkspace: mocks.resolveWorkspace,
}));
vi.mock("../thread-changes/coordinator.js", () => ({
  makeThreadChangesCoordinator: mocks.makeChangesCoordinator,
}));
vi.mock("./e2b/daemon-release.js", () => ({
  loadDaemonRelease: mocks.loadDaemonRelease,
  loadDaemonReleaseMetadata: mocks.loadDaemonReleaseMetadata,
}));
vi.mock("./e2b/daemon-installer.js", () => ({
  ensureDaemonInGuest: mocks.ensureDaemonInGuest,
}));
vi.mock("../source-control/tools.js", () => ({
  executeSourcePush: mocks.executeSourcePush,
}));

import {
  ExecutionWorkspaces,
  withCommandActivity,
  withThreadChanges,
} from "./execution-workspaces.js";

const thread = (value: string) => Schema.decodeUnknownSync(ThreadId)(value);

beforeEach(() => {
  mocks.firstThreadLifecycle.mockClear();
  mocks.firstWorkspaceReadiness.mockClear();
  mocks.firstSourceWorkspace.mockClear();
  mocks.bindThreadLifecycle.mockClear();
  mocks.runThreadLifecycle.mockClear();
  mocks.prepareThreadLifecycle.mockClear();
  mocks.resolveProfile.mockClear();
  mocks.loadRequirements.mockClear();
  mocks.decodeDb.mockClear();
  mocks.recordRunnerUsage.mockClear();
  mocks.publishRealtimeInvalidation.mockClear();
  mocks.publishRealtimeWorkspaceStatus.mockClear();
  mocks.runnerResourceAttribution.mockClear();
  mocks.executeSourcePush.mockClear();
  mocks.resolveWorkspace.mockClear();
  mocks.connectWorkspace.mockClear();
  mocks.makeChangesCoordinator.mockReset();
  mocks.loadDaemonRelease.mockClear();
  mocks.loadDaemonReleaseMetadata.mockClear();
  mocks.ensureDaemonInGuest.mockClear();
});

it("forwards the four-tool inventory through deployed workspace factories", () => {
  const sandbox = {} as Sandbox;
  const options = { subagents: {} };
  expect(
    ExecutionWorkspaces.sandboxFactory
      .tools?.(sandbox, options)
      .map(({ name }) => name),
  ).toEqual(["read", "write", "edit", "bash"]);
  expect(
    ExecutionWorkspaces.existingSandboxFactory
      .tools?.(sandbox, options)
      .map(({ name }) => name),
  ).toEqual(["read", "write", "edit", "bash"]);
});

const mintCredential = async () => ({
  id: "key_minted",
  key: Redacted.make("dxd_minted-key-value"),
});

describe("Thread Changes sandbox activation", () => {
  const request = {
    id: thread("thr_00000000-0000-4000-8000-000000000104"),
  };
  const sandbox = {
    cwd: "/home/user/workspace/repo",
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  } as unknown as Sandbox;
  const factory = {
    createSandbox: vi.fn(async () => sandbox),
  } satisfies SandboxFactory;

  beforeEach(() => {
    factory.createSandbox.mockClear();
    vi.mocked(sandbox.exec).mockClear();
    vi.mocked(sandbox.writeFile).mockClear();
    vi.mocked(sandbox.mkdir).mockClear();
    vi.mocked(sandbox.rm).mockClear();
  });

  it("exposes the sandbox while fencing its first mutation behind initial sync", async () => {
    let settleCapture: (() => void) | undefined;
    const onInitialSyncSettled = vi.fn();
    const sync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleCapture = resolve;
        }),
    );
    const runMutation = vi.fn(
      <A>(
        operation: () => Promise<A>,
        _options?: { readonly detectUnchanged?: boolean },
      ) => operation(),
    );
    mocks.makeChangesCoordinator.mockReturnValueOnce({
      sync,
      flush: vi.fn(),
      runMutation,
      terminalObserver: vi.fn(),
    });

    let exposed = false;
    const creating = withThreadChanges(factory, {
      db: mocks.db,
      bucket: {} as R2Bucket,
      threadId: request.id,
      onInitialSyncSettled,
    }).createSandbox(request);

    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
    const wrapped = await creating.then((value) => {
      exposed = true;
      return value;
    });
    expect(exposed).toBe(true);
    expect(onInitialSyncSettled).not.toHaveBeenCalled();

    const firstMutation = wrapped.writeFile("notes.txt", "notes");
    await Promise.resolve();
    expect(runMutation).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();

    settleCapture?.();
    await firstMutation;

    expect(onInitialSyncSettled).toHaveBeenCalledOnce();
    await wrapped.exec("git status");
    await wrapped.mkdir("output", { recursive: true });
    await wrapped.rm("output", { recursive: true });
    expect(runMutation).toHaveBeenCalledTimes(4);
    expect(runMutation.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      { detectUnchanged: true },
      undefined,
      undefined,
    ]);
    expect(sandbox.exec).toHaveBeenCalledWith("git status", undefined);
    expect(sandbox.writeFile).toHaveBeenCalledWith("notes.txt", "notes");
    expect(sandbox.mkdir).toHaveBeenCalledWith("output", { recursive: true });
    expect(sandbox.rm).toHaveBeenCalledWith("output", { recursive: true });
  });

  it("does not block availability on a failed sync and retries next activation", async () => {
    let rejectCapture: ((cause: Error) => void) | undefined;
    const firstSync = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCapture = reject;
        }),
    );
    const secondSync = vi.fn(async () => undefined);
    const onInitialSyncSettled = vi.fn();
    const runMutation = vi.fn(<A>(operation: () => Promise<A>) => operation());
    const coordinator = (sync: typeof firstSync | typeof secondSync) => ({
      sync,
      flush: vi.fn(),
      runMutation,
      terminalObserver: vi.fn(),
    });
    mocks.makeChangesCoordinator
      .mockReturnValueOnce(coordinator(firstSync))
      .mockReturnValueOnce(coordinator(secondSync));
    const changesFactory = withThreadChanges(factory, {
      db: mocks.db,
      bucket: {} as R2Bucket,
      threadId: request.id,
      onInitialSyncSettled,
    });

    const wrapped = await changesFactory.createSandbox(request);
    expect(wrapped).toBeDefined();
    expect(onInitialSyncSettled).not.toHaveBeenCalled();

    const mutation = wrapped.mkdir("after-failure");
    await Promise.resolve();
    expect(runMutation).not.toHaveBeenCalled();
    rejectCapture?.(new Error("R2 unavailable"));
    await expect(mutation).resolves.toBeUndefined();
    expect(runMutation).toHaveBeenCalledOnce();
    expect(onInitialSyncSettled).not.toHaveBeenCalled();

    await expect(changesFactory.createSandbox(request)).resolves.toBeDefined();
    await vi.waitFor(() => expect(onInitialSyncSettled).toHaveBeenCalledOnce());

    expect(firstSync).toHaveBeenCalledOnce();
    expect(secondSync).toHaveBeenCalledOnce();
  });
});

describe("sandbox command lifecycle admission", () => {
  it("rejects every sandbox mutation when the Thread becomes archived", async () => {
    const request = {
      id: thread("thr_00000000-0000-4000-8000-000000000105"),
    };
    const sandbox = {
      cwd: "/home/user/workspace/repo",
      exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const factory = {
      createSandbox: vi.fn(async () => sandbox),
    } satisfies SandboxFactory;
    const runCommand = vi.fn(
      async <A>(_timeoutMs: number, execute: () => Promise<A>) => execute(),
    );
    const authorizeCommand = vi.fn(async () => {
      throw new Error("Thread is not active.");
    });
    const wrapped = await withCommandActivity(
      factory,
      () => ({ runCommand }) as unknown as WorkspaceActivity,
      60_000,
      authorizeCommand,
    ).createSandbox(request);

    await expect(wrapped.exec("git status")).rejects.toThrow(
      "Thread is not active.",
    );
    await expect(wrapped.writeFile("notes.txt", "notes")).rejects.toThrow(
      "Thread is not active.",
    );
    await expect(wrapped.mkdir("output", { recursive: true })).rejects.toThrow(
      "Thread is not active.",
    );
    await expect(wrapped.rm("output", { recursive: true })).rejects.toThrow(
      "Thread is not active.",
    );

    expect(authorizeCommand).toHaveBeenCalledTimes(4);
    expect(runCommand).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(sandbox.mkdir).not.toHaveBeenCalled();
    expect(sandbox.rm).not.toHaveBeenCalled();
  });
});

describe("execution workspace admission", () => {
  it("skips resume and first-readiness writes for a confirmed running agent workspace", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000291");
    const sourceRun = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const providerSandbox = {
      commands: { run: sourceRun },
      files: { write: vi.fn(async () => undefined) },
      setTimeout: vi.fn(async () => undefined),
    };
    mocks.resolveWorkspace.mockImplementationOnce((options) => {
      options.observeResidency?.("running");
      return Effect.succeed(providerSandbox) as never;
    });

    await expect(
      ExecutionWorkspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).resolves.toBeDefined();

    expect(mocks.firstWorkspaceReadiness).toHaveBeenCalledOnce();
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ observeResidency: expect.any(Function) }),
    );
    expect(sourceRun).toHaveBeenCalledWith(
      "mkdir -p -- /home/user/workspace/repo && git -C /home/user/workspace/repo init && git -C /home/user/workspace/repo hash-object -w -t tree --stdin </dev/null",
      expect.objectContaining({ cwd: "/home/user" }),
    );
    expect(
      mocks.prepareThreadLifecycle.mock.calls.some(([sql]) =>
        (sql as string).includes("UPDATE execution_workspace"),
      ),
    ).toBe(false);
    expect(mocks.publishRealtimeWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("publishes wake status only around a confirmed paused workspace connection", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000294");
    const providerSandbox = {
      commands: {
        run: vi.fn(async () => {
          expect(mocks.publishRealtimeWorkspaceStatus.mock.calls).toEqual([
            [mocks.workerEnv, threadId, "waking"],
          ]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
      files: { write: vi.fn(async () => undefined) },
      setTimeout: vi.fn(async () => undefined),
    };
    mocks.resolveWorkspace.mockImplementationOnce(
      (options) =>
        Effect.promise(async () => {
          await options.observeResidency?.("paused");
          return providerSandbox;
        }) as never,
    );

    await expect(
      ExecutionWorkspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).resolves.toBeDefined();

    expect(mocks.publishRealtimeWorkspaceStatus.mock.calls).toEqual([
      [mocks.workerEnv, threadId, "waking"],
      [mocks.workerEnv, threadId, "ready"],
    ]);
  });

  it("does not skip first readiness for a confirmed running workspace", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000293");
    const sourceRun = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const providerSandbox = {
      commands: { run: sourceRun },
      files: { write: vi.fn(async () => undefined) },
      setTimeout: vi.fn(async () => undefined),
    };
    mocks.firstWorkspaceReadiness.mockResolvedValueOnce({
      ready_at: null,
      preparation_status: "Preparing source…",
    });
    mocks.firstGithubConnection.mockResolvedValueOnce({ connected: 1 });
    mocks.resolveWorkspace.mockImplementationOnce((options) => {
      options.observeResidency?.("running");
      return Effect.succeed(providerSandbox) as never;
    });

    await expect(
      ExecutionWorkspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).resolves.toBeDefined();

    expect(mocks.firstWorkspaceReadiness).toHaveBeenCalledOnce();
    expect(sourceRun).toHaveBeenCalledWith(
      "mkdir -p -- /home/user/workspace/repo && git -C /home/user/workspace/repo init && git -C /home/user/workspace/repo hash-object -w -t tree --stdin </dev/null",
      expect.objectContaining({ cwd: "/home/user" }),
    );
    // Warm (running) workspaces refresh the gh wrapper on every activation.
    expect(sourceRun).toHaveBeenCalledWith(GITHUB_CLI_WRAPPER_INSTALL_COMMAND, {
      envs: { DX_GH_WRAPPER: githubCliWrapper() },
      timeoutMs: 10_000,
    });
    expect(
      mocks.prepareThreadLifecycle.mock.calls.some(([sql]) =>
        (sql as string).includes("UPDATE execution_workspace"),
      ),
    ).toBe(true);
  });

  it("installs the daemon only through the direct existing-ID connector", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000292");
    const sourceRun = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const providerSandbox = {
      commands: { run: sourceRun },
      files: { write: vi.fn(async () => undefined) },
    };
    mocks.connectWorkspace.mockReturnValueOnce(
      Effect.succeed(providerSandbox) as never,
    );
    mocks.firstGithubConnection.mockResolvedValueOnce({ connected: 1 });

    await ExecutionWorkspaces.ensureDaemon({
      threadId,
      endpoint: "https://daemon.test",
      credential: {
        id: "key_1",
        key: Redacted.make("dxd_test-api-key-value"),
      },
      mintCredential,
      awaitRegistration: async () => false,
    });

    expect(mocks.resolveProfile).toHaveBeenCalledWith(
      mocks.workerEnv,
      threadId,
    );
    expect(mocks.connectWorkspace).toHaveBeenCalledOnce();
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled();
    expect(mocks.loadDaemonReleaseMetadata).toHaveBeenCalledWith(
      mocks.workerEnv,
    );
    expect(mocks.loadDaemonRelease).not.toHaveBeenCalled();
    expect(sourceRun).toHaveBeenCalledWith(
      "mkdir -p -- /home/user/workspace/repo && git -C /home/user/workspace/repo init && git -C /home/user/workspace/repo hash-object -w -t tree --stdin </dev/null",
      expect.objectContaining({ cwd: "/home/user" }),
    );
    expect(mocks.ensureDaemonInGuest).toHaveBeenCalledWith(
      providerSandbox,
      expect.objectContaining({
        threadId,
        sha256: "a".repeat(64),
        releaseUrl: expect.any(String),
        loadBinary: expect.any(Function),
        mintCredential,
      }),
    );
    expect(sourceRun).toHaveBeenCalledWith(GITHUB_CLI_WRAPPER_INSTALL_COMMAND, {
      envs: { DX_GH_WRAPPER: githubCliWrapper() },
      timeoutMs: 10_000,
    });
    expect(sourceRun.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureDaemonInGuest.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.firstThreadLifecycle).toHaveBeenCalled();
  });

  it("wakes a self-registering daemon without any guest command", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000295");
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const setTimeout = vi.fn(async (_durationMs: number) => undefined);
    mocks.connectWorkspace.mockReturnValueOnce(
      Effect.succeed({
        commands: { run },
        files: { write: vi.fn(async () => undefined) },
        setTimeout,
      }) as never,
    );
    const awaitRegistration = vi.fn(async () => true);

    await expect(
      ExecutionWorkspaces.ensureDaemon({
        threadId,
        endpoint: "https://daemon.test",
        mintCredential,
        awaitRegistration,
      }),
    ).resolves.toEqual({ bootstrapped: false });

    expect(mocks.connectWorkspace).toHaveBeenCalledOnce();
    expect(awaitRegistration).toHaveBeenCalledWith(3_000);
    expect(run).not.toHaveBeenCalled();
    expect(mocks.ensureDaemonInGuest).not.toHaveBeenCalled();
    // The connect set the E2B timeout; the wake replaces it with the
    // inactivity deadline even though no Terminal is attached.
    expect(setTimeout.mock.calls).toEqual([[75_000]]);
  });

  it("does not wait for a registration a newly minted key cannot produce", async () => {
    const awaitRegistration = vi.fn(async () => true);
    mocks.connectWorkspace.mockReturnValueOnce(
      Effect.succeed({
        commands: { run: vi.fn(async () => ({ exitCode: 0 })) },
        files: { write: vi.fn(async () => undefined) },
      }) as never,
    );

    await ExecutionWorkspaces.ensureDaemon({
      threadId: thread("thr_00000000-0000-4000-8000-000000000296"),
      endpoint: "https://daemon.test",
      credential: {
        id: "key_1",
        key: Redacted.make("dxd_test-api-key-value"),
      },
      mintCredential,
      awaitRegistration,
    });

    expect(awaitRegistration).not.toHaveBeenCalled();
    expect(mocks.ensureDaemonInGuest).toHaveBeenCalledOnce();
  });

  it("renews the sandbox deadline while source preparation outlasts a poll", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const threadId = thread("thr_00000000-0000-4000-8000-000000000297");
      const setTimeout = vi.fn(async (_durationMs: number) => undefined);
      const deadlinesDuringPreparation: number[][] = [];
      const providerSandbox = {
        commands: {
          run: vi.fn(async () => {
            if (deadlinesDuringPreparation.length === 0) {
              deadlinesDuringPreparation.push(
                setTimeout.mock.calls.map(([durationMs]) => durationMs),
              );
              // The activity coordinator polls every 30 s while it renews.
              await vi.advanceTimersByTimeAsync(30_000);
              deadlinesDuringPreparation.push(
                setTimeout.mock.calls.map(([durationMs]) => durationMs),
              );
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }),
        },
        files: { write: vi.fn(async () => undefined) },
        setTimeout,
      };
      mocks.resolveWorkspace.mockImplementationOnce((options) => {
        options.observeResidency?.("paused");
        return Effect.succeed(providerSandbox) as never;
      });

      await expect(
        ExecutionWorkspaces.sandboxFactory.createSandbox({ id: threadId }),
      ).resolves.toBeDefined();

      // The test requirements' inactivity deadline is 75 s.
      expect(deadlinesDuringPreparation).toEqual([[75_000], [75_000, 75_000]]);
      // Releasing the preparation lease publishes the final deadline once,
      // and nothing renews it afterwards.
      expect(setTimeout.mock.calls).toEqual([[75_000], [75_000], [75_000]]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(setTimeout).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the sandbox deadline while a daemon bootstrap runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const setTimeout = vi.fn(async (_durationMs: number) => undefined);
      mocks.connectWorkspace.mockReturnValueOnce(
        Effect.succeed({
          commands: {
            run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
          },
          files: { write: vi.fn(async () => undefined) },
          setTimeout,
        }) as never,
      );
      let deadlinesDuringInstall: number[] = [];
      mocks.ensureDaemonInGuest.mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        deadlinesDuringInstall = setTimeout.mock.calls.map(
          ([durationMs]) => durationMs,
        );
      });

      await ExecutionWorkspaces.ensureDaemon({
        threadId: thread("thr_00000000-0000-4000-8000-000000000298"),
        endpoint: "https://daemon.test",
        mintCredential,
        awaitRegistration: async () => false,
      });

      // The connect's replacement, the lease, and one 30 s renewal.
      expect(deadlinesDuringInstall).toEqual([75_000, 75_000, 75_000]);
      expect(setTimeout).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(setTimeout).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed gh wrapper installation without failing activation", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000294");
    const warn = vi
      .spyOn(executionWorkspaceLogger, "warn")
      .mockImplementation(() => {});
    // E2B rejects a nonzero exit with the command's stderr in the message.
    const exitError =
      "Command exited with code 1 and error:\nmkdir: cannot create directory '/home/user/.local/bin': Permission denied";
    const sourceRun = vi.fn(async (command: string) => {
      if (command === GITHUB_CLI_WRAPPER_INSTALL_COMMAND)
        throw new Error(exitError);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mocks.connectWorkspace.mockReturnValueOnce(
      Effect.succeed({
        commands: { run: sourceRun },
        files: { write: vi.fn(async () => undefined) },
      }) as never,
    );
    mocks.firstGithubConnection.mockResolvedValueOnce({ connected: 1 });

    await ExecutionWorkspaces.ensureDaemon({
      threadId,
      endpoint: "https://daemon.test",
      credential: {
        id: "key_1",
        key: Redacted.make("dxd_test-api-key-value"),
      },
      mintCredential,
      awaitRegistration: async () => false,
    });

    expect(warn).toHaveBeenCalledWith(
      "GitHub CLI wrapper installation failed.",
      { event: "github_cli_wrapper", threadId, error: exitError },
    );
    expect(mocks.ensureDaemonInGuest).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("attributes parallel release metadata failures to the release stage", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000293");
    const failure = new Error("invalid release metadata");
    const log = vi
      .spyOn(threadDaemonLogger, "error")
      .mockImplementation(() => {});
    mocks.loadDaemonReleaseMetadata.mockRejectedValueOnce(failure);
    mocks.connectWorkspace.mockReturnValueOnce(
      Effect.succeed({
        commands: { run: vi.fn(async () => ({ exitCode: 0 })) },
        files: { write: vi.fn(async () => undefined) },
      }) as never,
    );

    await expect(
      ExecutionWorkspaces.ensureDaemon({
        threadId,
        endpoint: "https://daemon.test",
        mintCredential,
        awaitRegistration: async () => false,
      }),
    ).rejects.toBe(failure);

    expect(log).toHaveBeenCalledWith(
      "Thread daemon installation failed.",
      expect.objectContaining({ stage: "release" }),
    );
    log.mockRestore();
  });

  it("passes the resolved profile through sandbox creation without resolving it twice", async () => {
    const threadId = thread("thr_00000000-0000-4000-8000-000000000102");
    const firstProfile = { ...mocks.profile, template: "first-template" };
    const secondProfile = { ...mocks.profile, template: "second-template" };
    mocks.resolveProfile
      .mockReturnValueOnce(Effect.succeed(firstProfile))
      .mockReturnValueOnce(Effect.succeed(secondProfile));
    mocks.resolveWorkspace.mockReturnValueOnce(
      Effect.succeed({
        commands: { run: vi.fn(async () => ({ exitCode: 0 })) },
        files: { write: vi.fn(async () => undefined) },
        setTimeout: vi.fn(async () => undefined),
      }) as never,
    );

    await expect(
      ExecutionWorkspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).resolves.toBeDefined();

    expect(mocks.resolveProfile).toHaveBeenCalledOnce();
    expect(mocks.loadRequirements).toHaveBeenCalledWith(
      mocks.workerEnv,
      "first-template",
    );
  });
});
