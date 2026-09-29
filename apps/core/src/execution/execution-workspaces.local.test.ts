import type { Sandbox } from "@flue/runtime";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const threadId = "thr_00000000-0000-4000-8000-000000000332";
  const source = {
    owner_user_id: "user-local-332",
    snapshot_thread_id: threadId,
    snapshot_project_id: "prj_00000000-0000-4000-8000-000000000332",
    snapshot_binding_revision: 1,
    snapshot_provider: "github",
    snapshot_repository_full_name: "dxcode-dev/local-fixture",
    snapshot_clone_url: "https://github.com/dxcode-dev/local-fixture.git",
    snapshot_default_branch: "main",
    snapshot_initial_ref: "refs/heads/main",
    snapshot_initial_commit_sha: "a".repeat(40),
    snapshot_created_at: "2026-09-03T00:00:00.000Z",
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
  };
  const firstLifecycle = vi.fn(async () => ({ lifecycle_state: "active" }));
  const firstSource = vi.fn(async () => source);
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: sql.includes("thread_source_snapshot")
          ? firstSource
          : firstLifecycle,
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      })),
    })),
  } as unknown as D1Database;
  const primitiveExec = vi.fn(
    async (command: string, options?: { cwd?: string }) => ({
      stdout:
        command === "pwd -P"
          ? `${options?.cwd ?? ""}\n`
          : command.endsWith(" snapshot")
            ? JSON.stringify({
                status: "ready",
                modules: [],
                lfsNeeded: false,
                shallow: false,
                fullHistoryNeeded: false,
              })
            : command.endsWith(" hooks")
              ? JSON.stringify({ status: "ready" })
              : "",
      stderr: "",
      exitCode: 0,
    }),
  );
  const primitive = {
    cwd: "/home/user/workspace/repo",
    resolvePath: (path: string) => path,
    exec: primitiveExec,
    readFile: vi.fn(async () => ""),
    readFileBuffer: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(),
    readdir: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  } as unknown as Sandbox;
  return {
    threadId,
    db,
    firstLifecycle,
    firstSource,
    primitive,
    primitiveExec,
    localCreateSandbox: vi.fn(async () => primitive),
    requestLocalRuntime: vi.fn(async () => ({
      root: "/tmp/dx-local/workspace/repo",
      state: "/tmp/dx-local/state.json",
      claim: "/tmp/dx-local/claim.json",
      logDirectory: "/tmp/dx-local/logs",
      helper: "/tmp/dx-local/dx-git-credential",
      templateDirectory: "/tmp/dx-local/template",
      home: "/tmp/dx-local",
      workspaceParent: "/tmp/dx-local/workspace",
      gitHome: "/tmp/dx-local/git-home",
      fixtureRemote: "/tmp/dx-local/source-fixture.git",
    })),
    resolveEnvironment: vi.fn(() => Effect.succeed({ values: [] })),
    activateDaemon: vi.fn(async () => undefined),
    startDaemonActivation: vi.fn(async () => undefined),
    githubAdapter: vi.fn(() => {
      throw new Error("GitHub adapter must not be constructed in local mode.");
    }),
    resolveWorkspace: vi.fn(() =>
      Effect.die("E2B resolver must not run in local mode."),
    ),
    connectWorkspace: vi.fn(() =>
      Effect.die("E2B connector must not run in local mode."),
    ),
    sandboxTools: vi.fn(() => []),
    e2b: vi.fn(() => {
      throw new Error("E2B adapter must not run in local mode.");
    }),
    changesSync: vi.fn(async () => undefined),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: {
    DB: mocks.db,
    DX_RUNTIME_MODE: "local",
    DX_LOCAL_RUNTIME_URL: "http://127.0.0.1:5175/",
    DX_LOCAL_RUNTIME_TOKEN: "local-runtime-test-token-000000000000",
  },
}));
vi.mock("../persistence/d1-binding.js", () => ({
  decodeD1Binding: () => Effect.succeed(mocks.db),
}));
vi.mock("./local/adapter.js", () => ({
  localSandboxFactory: () => ({
    createSandbox: mocks.localCreateSandbox,
  }),
  requestLocalRuntime: mocks.requestLocalRuntime,
}));
vi.mock("../settings/environment-variables/execution.js", () => ({
  resolveExecutionEnvironment: mocks.resolveEnvironment,
}));
vi.mock("../threads/daemon-client.js", () => ({
  activateThreadDaemon: mocks.activateDaemon,
  startThreadDaemonActivation: mocks.startDaemonActivation,
  drainThreadDaemon: vi.fn(async () => undefined),
  queueThreadChangesRefresh: vi.fn(async () => undefined),
}));
vi.mock(
  "../source-control/github/runtime-adapter.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../source-control/github/runtime-adapter.js")
      >();
    return { ...original, GitHubRuntimeAdapterLive: mocks.githubAdapter };
  },
);
vi.mock("./e2b/resolver.js", () => ({
  connectExistingExecutionWorkspace: mocks.connectWorkspace,
  makeD1ExecutionWorkspaceCoordinator: vi.fn(() => ({})),
  makeD1ExecutionWorkspaceStateStore: vi.fn(() => ({})),
  pauseExecutionWorkspace: vi.fn(() => Effect.void),
  resolveExecutionWorkspace: mocks.resolveWorkspace,
}));
vi.mock("./e2b/adapter.js", () => ({
  dxSandboxTools: mocks.sandboxTools,
  e2b: mocks.e2b,
}));
vi.mock("../thread-changes/coordinator.js", () => ({
  makeThreadChangesCoordinator: vi.fn(() => ({
    sync: mocks.changesSync,
    runMutation: (operation: () => Promise<unknown>) => operation(),
  })),
}));

import { env } from "cloudflare:workers";
import { executeTrustedSourceCommand } from "./e2b/source-command-admission.js";
import { ExecutionWorkspaces } from "./execution-workspaces.js";

beforeEach(() => {
  mocks.firstLifecycle.mockClear();
  mocks.firstSource.mockClear();
  mocks.primitiveExec.mockClear();
  mocks.localCreateSandbox.mockClear();
  mocks.requestLocalRuntime.mockClear();
  mocks.resolveEnvironment.mockClear();
  mocks.activateDaemon.mockClear();
  mocks.startDaemonActivation.mockClear();
  mocks.githubAdapter.mockClear();
  mocks.resolveWorkspace.mockClear();
  mocks.connectWorkspace.mockClear();
  mocks.e2b.mockClear();
  mocks.changesSync.mockClear();
});

describe("local execution workspace source boundary", () => {
  it("forwards the four-tool inventory through local workspace factories", () => {
    expect(ExecutionWorkspaces.sandboxFactory.tools).toBe(mocks.sandboxTools);
    expect(ExecutionWorkspaces.existingSandboxFactory.tools).toBe(
      mocks.sandboxTools,
    );
  });

  it("repairs changes against the primitive existing sandbox", async () => {
    const bindings = env as { DX_STORAGE?: R2Bucket };
    bindings.DX_STORAGE = {} as R2Bucket;
    try {
      await ExecutionWorkspaces.repairChanges(mocks.threadId as never);
    } finally {
      delete bindings.DX_STORAGE;
    }

    expect(mocks.localCreateSandbox).toHaveBeenCalledExactlyOnceWith({
      id: mocks.threadId,
    });
    expect(mocks.changesSync).toHaveBeenCalledOnce();
    expect(mocks.firstSource).not.toHaveBeenCalled();
    expect(mocks.resolveEnvironment).not.toHaveBeenCalled();
  });

  it("fails source-provider admission before any GitHub, E2B, or command callback", async () => {
    const sandbox = await ExecutionWorkspaces.sandboxFactory.createSandbox({
      id: mocks.threadId,
    });
    expect(mocks.requestLocalRuntime).toHaveBeenCalledWith(
      expect.anything(),
      mocks.threadId,
      "source",
      {},
    );
    expect(mocks.startDaemonActivation).toHaveBeenCalledWith(
      expect.anything(),
      mocks.threadId,
      undefined,
    );

    mocks.primitiveExec.mockClear();
    await expect(
      executeTrustedSourceCommand(sandbox, "gh repo view", {
        operation: "repository-read",
        invocationSource: "agent-command",
      }),
    ).rejects.toMatchObject({
      _tag: "SourceControlProviderFailure",
      provider: "github",
      retryable: false,
    });

    expect(mocks.primitiveExec).not.toHaveBeenCalled();
    expect(mocks.resolveEnvironment).not.toHaveBeenCalled();
    expect(mocks.githubAdapter).not.toHaveBeenCalled();
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled();
    expect(mocks.connectWorkspace).not.toHaveBeenCalled();
    expect(mocks.e2b).not.toHaveBeenCalled();
  });
});
