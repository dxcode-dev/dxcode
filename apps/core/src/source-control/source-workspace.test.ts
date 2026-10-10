import {
  SourceWorkspaceRepository,
  ThreadSourceAuthority,
  ThreadSourceIntent,
  ThreadSourceSnapshot,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  type WorkspacePreparation,
  workspacePreparationFor,
} from "../execution/workspace-preparation.js";
import { SourceRuntimeBroker } from "./runtime.js";
import {
  SCRATCH_WORKSPACE_CWD,
  SOURCE_WORKSPACE_CWD,
  SourceWorkspaceConflict,
  SourceWorkspaceService,
  SourceWorkspaceServiceLive,
} from "./source-workspace.js";

const threadId = "thr_00000000-0000-4000-8000-000000000116" as const;
const token = "synthetic-token-116";
const snapshot = Schema.decodeUnknownSync(ThreadSourceSnapshot)({
  version: 2,
  threadId,
  projectId: "prj_00000000-0000-4000-8000-000000000116",
  bindingRevision: 1,
  provider: "github",
  repositoryName: "owner/repository",
  cloneUrl: "https://github.com/owner/repository.git",
  defaultBranch: "main",
  sourceRevision: "a".repeat(40),
  initialRef: "refs/heads/main",
  capturedAt: "2026-08-25T12:00:00.000Z",
});
const authority = Schema.decodeUnknownSync(ThreadSourceAuthority)({
  threadId,
  grantId: "grant-116",
  installationId: "9116",
  providerRepositoryId: "7116",
  authorizationEpoch: 1,
  installationEpoch: 1,
  policyRevision: 0,
  privateSubmoduleRepositoryIds: [],
});
const intent = Schema.decodeUnknownSync(ThreadSourceIntent)({
  version: 1,
  threadId,
  projectId: snapshot.projectId,
  bindingRevision: 1,
  provider: "github",
  repositoryName: "owner/repository",
  cloneUrl: "https://github.com/owner/repository.git",
  createdAt: "2026-08-25T12:00:00.000Z",
});
const bitbucketSnapshot = Schema.decodeUnknownSync(ThreadSourceSnapshot)({
  ...snapshot,
  provider: "bitbucket",
  cloneUrl: "https://bitbucket.org/owner/repository.git",
  capturedAt: "2026-08-25T12:00:00.000Z",
});
const bitbucketIntent = Schema.decodeUnknownSync(ThreadSourceIntent)({
  ...intent,
  provider: "bitbucket",
  cloneUrl: "https://bitbucket.org/owner/repository.git",
  createdAt: "2026-08-25T12:00:00.000Z",
});
const publicGitIntent = Schema.decodeUnknownSync(ThreadSourceIntent)({
  ...intent,
  provider: "git",
  repositoryName: "group/owner/repository",
  cloneUrl: "https://git.example.test/group/owner/repository.git",
  createdAt: "2026-08-25T12:00:00.000Z",
});

const makeSandbox = (
  inspectExitCodes: Array<number>,
  input?: {
    readonly modules?: string;
    readonly lfs?: boolean;
    readonly actionExitCodes?: Readonly<Record<string, number>>;
    readonly timeline?: Array<string>;
    readonly assetState?: "fresh" | "stale";
    readonly missingTool?: "git" | "gh" | "git-lfs";
    readonly rejectedAssetVerification?: boolean;
    readonly shallow?: boolean;
    readonly fullHistoryNeeded?: boolean;
  },
) => {
  const calls: Array<{
    command: string;
    environment?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
  }> = [];
  const commands = {
    run: vi.fn(
      async (
        command: string,
        options?: {
          cwd?: string;
          envs?: Record<string, string>;
          timeoutMs?: number;
        },
      ) => {
        calls.push({
          command,
          environment: options?.envs,
          cwd: options?.cwd,
          timeoutMs: options?.timeoutMs,
        });
        const checkout = (exitCode: number) => ({
          status:
            exitCode === 10
              ? "absent"
              : exitCode === 20
                ? "conflict"
                : exitCode === 0
                  ? "ready"
                  : "failed",
          modules: JSON.parse(input?.modules ?? "[]"),
          lfsNeeded: input?.lfs ?? false,
          shallow: input?.shallow ?? false,
          fullHistoryNeeded: input?.fullHistoryNeeded ?? false,
        });
        if (command.includes("DX_ASSET_HELPER_DIGEST")) {
          if (input?.rejectedAssetVerification === true)
            throw new Error("asset verification unavailable");
          const requiredTools = JSON.parse(
            options?.envs?.DX_ASSET_TOOLS ?? "[]",
          ) as Array<"git" | "gh" | "git-lfs">;
          const tools = requiredTools.map((tool) => ({
            tool,
            status: tool === input?.missingTool ? "missing" : "ok",
          }));
          const action = options?.envs?.DX_ASSET_ACTION;
          let operation:
            | { stdout: string; stderr: string; exitCode: number }
            | undefined;
          if (
            input?.assetState !== "stale" &&
            (input?.missingTool === undefined ||
              !requiredTools.includes(input.missingTool)) &&
            (action === "snapshot" || action === "activate")
          ) {
            input?.timeline?.push(action);
            const state = checkout(inspectExitCodes.shift() ?? 0);
            const hookExitCode = input?.actionExitCodes?.hooks ?? 0;
            const hooks =
              action === "activate" &&
              state.status === "ready" &&
              state.modules.length === 0 &&
              !state.lfsNeeded &&
              !state.fullHistoryNeeded
                ? hookExitCode === 30 || hookExitCode === 31
                  ? {
                      status: "ready",
                      failed: [hookExitCode === 30 ? "setup" : "resume"],
                    }
                  : { status: hookExitCode === 20 ? "conflict" : "ready" }
                : undefined;
            operation = {
              stdout: JSON.stringify(
                action === "activate"
                  ? {
                      checkout: state,
                      ...(hooks === undefined ? {} : { hooks }),
                    }
                  : state,
              ),
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: JSON.stringify({
              assets: input?.assetState ?? "fresh",
              tools,
              ...(operation === undefined ? {} : { operation }),
            }),
            stderr: "",
            exitCode:
              input?.missingTool === undefined ||
              !requiredTools.includes(input.missingTool)
                ? 0
                : 43,
          };
        }
        const action = command.split(" ").at(-1);
        if (
          action !== undefined &&
          [
            "snapshot",
            "initialize",
            "initialize-anonymous",
            "initialize-exact-anonymous",
            "submodule",
            "lfs",
            "unshallow",
            "unshallow-anonymous",
            "hooks",
            "mark-provisioned",
          ].includes(action)
        )
          input?.timeline?.push(action);
        if (action === "snapshot") {
          const exitCode = inspectExitCodes.shift() ?? 0;
          return {
            stdout: JSON.stringify(checkout(exitCode)),
            stderr: "",
            exitCode: 0,
          };
        }
        if (action === "initialize-anonymous")
          return {
            stdout: JSON.stringify({
              sourceRevision: snapshot.sourceRevision,
              defaultBranch: snapshot.defaultBranch,
              initialRef: snapshot.initialRef,
            }),
            stderr: "",
            exitCode: input?.actionExitCodes?.[action] ?? 0,
          };
        if (action === "initialize" || action === "initialize-exact-anonymous")
          return {
            stdout: JSON.stringify(
              checkout(input?.actionExitCodes?.[action] ?? 0),
            ),
            stderr: "",
            exitCode: input?.actionExitCodes?.[action] ?? 0,
          };
        if (action === "hooks") {
          const exitCode = input?.actionExitCodes?.[action] ?? 0;
          return {
            stdout: JSON.stringify(
              exitCode === 30 || exitCode === 31
                ? {
                    status: "ready",
                    failed: [exitCode === 30 ? "setup" : "resume"],
                  }
                : { status: exitCode === 20 ? "conflict" : "ready" },
            ),
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "",
          exitCode: input?.actionExitCodes?.[action ?? ""] ?? 0,
        };
      },
    ),
  };
  const files = {
    write: vi.fn(async () => undefined),
  };
  return {
    preparation: workspacePreparationFor({ commands, files }),
    calls,
    commands,
    files,
  };
};

const serviceLayer = (input: {
  readonly source?: typeof snapshot;
  readonly intent?: typeof intent;
  readonly anonymous?: boolean;
  readonly finalizations?: Array<unknown>;
  readonly timeline?: Array<string>;
  readonly leases?: Array<string>;
  readonly leaseTargets?: Array<string | undefined>;
  readonly privateSubmodules?: ReadonlyArray<{
    readonly providerRepositoryId: string;
    readonly repositoryName: string;
  }>;
}) => {
  const leases = input.leases ?? [];
  return SourceWorkspaceServiceLive.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(
          SourceWorkspaceRepository,
          SourceWorkspaceRepository.of({
            findByThreadId: () =>
              Effect.succeed({
                actorUserId: "user-116",
                ...(input.source === undefined
                  ? {}
                  : { snapshot: input.source }),
                ...(input.intent === undefined ? {} : { intent: input.intent }),
                ...(input.source === undefined || input.anonymous === true
                  ? {}
                  : { authority }),
                privateSubmodules: input.privateSubmodules ?? [],
              }),
            finalizeAnonymous: (sourceIntent, finalization) => {
              input.timeline?.push("finalize");
              input.finalizations?.push({ sourceIntent, finalization });
              return Schema.decodeUnknownEffect(
                Schema.toType(ThreadSourceSnapshot),
              )({
                version: 2,
                threadId: sourceIntent.threadId,
                projectId: sourceIntent.projectId,
                bindingRevision: sourceIntent.bindingRevision,
                provider: sourceIntent.provider,
                repositoryName: sourceIntent.repositoryName,
                cloneUrl: sourceIntent.cloneUrl,
                defaultBranch: finalization.defaultBranch,
                sourceRevision: finalization.sourceRevision,
                initialRef: finalization.initialRef,
                capturedAt: finalization.capturedAt,
              });
            },
          }),
        ),
        Layer.succeed(
          SourceRuntimeBroker,
          SourceRuntimeBroker.of({
            withCommandEnvironment: (
              _threadId,
              _actorUserId,
              _request,
              callback,
              targetProviderRepositoryId,
            ) => {
              const next = `${token}-${leases.length + 1}`;
              leases.push(next);
              input.leaseTargets?.push(targetProviderRepositoryId);
              return callback({ GH_TOKEN: next });
            },
          }),
        ),
      ),
    ),
  );
};

const activate = (
  preparation: WorkspacePreparation,
  layer: ReturnType<typeof serviceLayer>,
  options?: { readonly runResume?: boolean },
  onPreparationPhase?: (phase: string) => Effect.Effect<void>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SourceWorkspaceService).activate(
        threadId,
        preparation,
        onPreparationPhase,
        options,
      );
    }).pipe(Effect.provide(layer)),
  );

const prepare = (
  preparation: WorkspacePreparation,
  layer: ReturnType<typeof serviceLayer>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SourceWorkspaceService).prepare(
        threadId,
        preparation,
      );
    }).pipe(Effect.provide(layer)),
  );

describe("SourceWorkspaceService", () => {
  it("creates the standard empty workspace for scratch Threads without source setup", async () => {
    const fake = makeSandbox([]);
    await expect(activate(fake.preparation, serviceLayer({}))).resolves.toBe(
      SOURCE_WORKSPACE_CWD,
    );
    expect(fake.calls).toEqual([
      {
        command: `mkdir -p -- ${SOURCE_WORKSPACE_CWD} && git -C ${SOURCE_WORKSPACE_CWD} init && git -C ${SOURCE_WORKSPACE_CWD} hash-object -w -t tree --stdin </dev/null`,
        environment: undefined,
        cwd: SCRATCH_WORKSPACE_CWD,
        timeoutMs: 10_000,
      },
    ]);
    expect(fake.files.write).not.toHaveBeenCalled();
  });

  it("uses one asset check, then initializes and runs merged hooks with a fresh callback token", async () => {
    const leases: string[] = [];
    const fake = makeSandbox([10]);
    await expect(
      activate(fake.preparation, serviceLayer({ source: snapshot, leases })),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);
    expect(leases).toEqual([`${token}-1`]);
    expect(
      fake.calls.find(({ command }) =>
        command.includes("DX_ASSET_HELPER_DIGEST"),
      ),
    ).toMatchObject({
      cwd: SCRATCH_WORKSPACE_CWD,
      timeoutMs: 680_000,
    });
    expect(fake.calls[0]?.environment?.DX_ASSET_ACTION_TIMEOUT_MS).toBe(
      "660000",
    );
    const actions = fake.calls
      .map(({ command }) => command.split(" ").at(-1))
      .filter((action) =>
        ["snapshot", "initialize", "hooks"].includes(action ?? ""),
      );
    expect(actions).toEqual(["initialize", "hooks"]);
    expect(fake.commands.run).toHaveBeenCalledTimes(3);
    expect(fake.files.write).not.toHaveBeenCalled();
    const network = fake.calls.find(({ command }) =>
      command.endsWith(" initialize"),
    );
    expect(network?.environment?.GH_TOKEN).toBe(`${token}-1`);
    expect(
      fake.calls
        .filter(({ command }) => !command.endsWith(" initialize"))
        .every(({ environment }) => environment?.GH_TOKEN === undefined),
    ).toBe(true);
    expect(
      JSON.stringify(fake.calls.map(({ command }) => command)),
    ).not.toContain(token);
    expect(JSON.stringify(fake.files.write.mock.calls)).not.toContain(token);
  });

  it("installs the source assets only after the one-command digest check reports drift", async () => {
    const fake = makeSandbox([0], { assetState: "stale" });

    await expect(
      activate(fake.preparation, serviceLayer({ source: snapshot })),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    expect(fake.commands.run).toHaveBeenCalledTimes(5);
    expect(fake.files.write).toHaveBeenCalledTimes(2);
    expect(
      fake.calls.filter(({ command }) => command.includes(" prepare ")),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(({ command }) => command.includes(" finalize ")),
    ).toHaveLength(1);
    expect(
      fake.calls
        .filter(({ command }) => command.includes("source-control.lock"))
        .every(({ command }) =>
          command.includes(
            "if test -L /home/user/.local/state/dx || { test -e /home/user/.local/state/dx && ! test -d /home/user/.local/state/dx; }; then exit 1; fi\ninstall -d -m 0700 /home/user/.local/state/dx\nflock -x",
          ),
        ),
    ).toBe(true);
  });

  it("requires only Git to activate a repository checkout", async () => {
    const fake = makeSandbox([0]);
    await activate(
      fake.preparation,
      serviceLayer({ source: bitbucketSnapshot }),
    );
    const assetCheck = fake.calls.find(({ command }) =>
      command.includes("DX_ASSET_HELPER_DIGEST"),
    );
    expect(assetCheck?.environment?.DX_ASSET_TOOLS).toBe(
      JSON.stringify(["git"]),
    );
    expect(
      fake.calls.find(
        ({ environment }) => environment?.DX_ASSET_ACTION === "activate",
      )?.environment,
    ).toMatchObject({
      DX_SOURCE_PROVIDER: "bitbucket",
      DX_CLONE_URL: "https://bitbucket.org/owner/repository.git",
    });
  });

  it("maps a rejected template tool check to an actionable template error", async () => {
    const fake = makeSandbox([], { missingTool: "git" });

    await expect(
      activate(fake.preparation, serviceLayer({ source: bitbucketSnapshot })),
    ).rejects.toMatchObject({
      _tag: "SourceRuntimeToolUnavailable",
      tool: "git",
      action: "update-e2b-template",
    });
  });

  it("does not misclassify an asset-verification transport failure as template drift", async () => {
    const fake = makeSandbox([], { rejectedAssetVerification: true });

    await expect(
      activate(fake.preparation, serviceLayer({ source: snapshot })),
    ).rejects.toMatchObject({ _tag: "SourceWorkspaceInitializationFailed" });
  });

  it("finalizes anonymous default HEAD before source setup without minting a token", async () => {
    const finalizations: Array<unknown> = [];
    const leases: string[] = [];
    const timeline: string[] = [];
    const fake = makeSandbox([0], { timeline });

    await expect(
      activate(
        fake.preparation,
        serviceLayer({
          intent,
          anonymous: true,
          finalizations,
          leases,
          timeline,
        }),
      ),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    expect(leases).toEqual([]);
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0]).toMatchObject({
      sourceIntent: intent,
      finalization: {
        sourceRevision: snapshot.sourceRevision,
        defaultBranch: "main",
        initialRef: "refs/heads/main",
      },
    });
    expect(timeline).toEqual([
      "initialize-anonymous",
      "finalize",
      "snapshot",
      "hooks",
    ]);
    expect(
      fake.calls.every(
        ({ environment }) => environment?.GH_TOKEN === undefined,
      ),
    ).toBe(true);
  });

  it("clones an anonymous repository when optional provider tools are absent", async () => {
    const finalizations: Array<unknown> = [];
    const leases: string[] = [];
    const fake = makeSandbox([0], { missingTool: "git-lfs" });

    await expect(
      activate(
        fake.preparation,
        serviceLayer({
          intent: publicGitIntent,
          anonymous: true,
          finalizations,
          leases,
        }),
      ),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    expect(leases).toEqual([]);
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0]).toMatchObject({ sourceIntent: publicGitIntent });
    expect(
      fake.calls.find(({ command }) =>
        command.endsWith(" initialize-anonymous"),
      )?.environment,
    ).not.toHaveProperty("GH_TOKEN");
  });

  it("activates an anonymous canonical Bitbucket intent without credentials", async () => {
    const leases: string[] = [];
    const finalizations: Array<unknown> = [];
    const fake = makeSandbox([0]);
    await activate(
      fake.preparation,
      serviceLayer({
        intent: bitbucketIntent,
        anonymous: true,
        leases,
        finalizations,
      }),
    );
    expect(leases).toEqual([]);
    expect(finalizations[0]).toMatchObject({ sourceIntent: bitbucketIntent });
    expect(
      fake.calls.find(({ command }) =>
        command.endsWith(" initialize-anonymous"),
      )?.environment,
    ).toMatchObject({
      DX_SOURCE_PROVIDER: "bitbucket",
      DX_CLONE_URL: "https://bitbucket.org/owner/repository.git",
    });
  });

  it("does not finalize or run hooks after an anonymous clone failure", async () => {
    const finalizations: Array<unknown> = [];
    const leases: string[] = [];
    const timeline: string[] = [];
    const fake = makeSandbox([0], {
      timeline,
      actionExitCodes: { "initialize-anonymous": 40 },
    });

    await expect(
      activate(
        fake.preparation,
        serviceLayer({
          intent,
          anonymous: true,
          finalizations,
          leases,
          timeline,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SourceWorkspaceInitializationFailed" });

    expect(timeline).toEqual(["initialize-anonymous"]);
    expect(finalizations).toEqual([]);
    expect(leases).toEqual([]);
    expect(
      fake.calls.every(
        ({ environment }) => environment?.GH_TOKEN === undefined,
      ),
    ).toBe(true);
  });

  it("prepares the exact source without running hooks before dxd", async () => {
    const fake = makeSandbox([0]);
    await expect(
      prepare(fake.preparation, serviceLayer({ source: snapshot })),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);
    const actions = fake.calls.map(({ command }) => command.split(" ").at(-1));
    expect(actions).not.toContain("hooks");
    expect(actions.at(-1)).toBe("mark-provisioned");
  });

  it("leaves provisioning open when preparation defers a full-history unshallow", async () => {
    const fake = makeSandbox([0], { shallow: true, fullHistoryNeeded: true });
    await expect(
      prepare(fake.preparation, serviceLayer({ source: snapshot })),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);
    const actions = fake.calls.map(({ command }) => command.split(" ").at(-1));
    expect(actions).not.toContain("mark-provisioned");
  });

  it("warms a matching checkout in one verified Worker-to-guest call without a lease", async () => {
    const leases: string[] = [];
    const timeline: string[] = [];
    const fake = makeSandbox([0], { timeline });
    await activate(
      fake.preparation,
      serviceLayer({ source: snapshot, leases }),
      undefined,
      (phase) => Effect.sync(() => timeline.push(phase)),
    );
    expect(leases).toEqual([]);
    expect(
      fake.calls.some(({ command }) => command.endsWith(" initialize")),
    ).toBe(false);
    expect(fake.commands.run).toHaveBeenCalledTimes(1);
    expect(fake.files.write).not.toHaveBeenCalled();
    expect(timeline).toEqual(["running-setup", "activate"]);
  });

  it("runs hooks in the same call when selected private submodules need no work", async () => {
    const fake = makeSandbox([0]);

    await expect(
      activate(
        fake.preparation,
        serviceLayer({
          source: snapshot,
          privateSubmodules: [
            {
              providerRepositoryId: "8116",
              repositoryName: "owner/private",
            },
          ],
        }),
      ),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    expect(fake.commands.run).toHaveBeenCalledTimes(1);
    expect(fake.calls[0]?.environment?.DX_ASSET_ACTION).toBe("activate");
  });

  it("initializes only selected GitHub submodules and leaves the rest to the user", async () => {
    const leases: string[] = [];
    const fake = makeSandbox([0], {
      modules: JSON.stringify([
        {
          key: "public",
          path: "vendor/public",
          repositoryName: "owner/public",
        },
      ]),
    });

    await expect(
      activate(fake.preparation, serviceLayer({ source: snapshot, leases })),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    expect(leases).toEqual([]);
    expect(
      fake.calls.some(({ command }) => command.endsWith(" submodule")),
    ).toBe(false);
  });

  it("activates the workspace when repository setup or resume fails", async () => {
    for (const hooks of [30, 31]) {
      const fake = makeSandbox([0], { actionExitCodes: { hooks } });
      await expect(
        activate(fake.preparation, serviceLayer({ source: snapshot })),
      ).resolves.toBe(SOURCE_WORKSPACE_CWD);
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("keeps setup verification but skips resume after a known-running reconnect", async () => {
    const fake = makeSandbox([0]);

    await expect(
      activate(fake.preparation, serviceLayer({ source: snapshot }), {
        runResume: false,
      }),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    const hooksCall = fake.calls.find(
      ({ environment }) => environment?.DX_ASSET_ACTION === "activate",
    );
    expect(hooksCall?.environment?.DX_RUN_RESUME).toBe("false");
  });

  it("uses separate exact-repository leases for a selected submodule and root LFS", async () => {
    const leases: string[] = [];
    const leaseTargets: Array<string | undefined> = [];
    const fake = makeSandbox([10], {
      modules: JSON.stringify([
        {
          key: "private",
          path: "vendor/private",
          repositoryName: "owner/private",
        },
      ]),
      lfs: true,
    });
    await activate(
      fake.preparation,
      serviceLayer({
        source: snapshot,
        leases,
        leaseTargets,
        privateSubmodules: [
          {
            providerRepositoryId: "8116",
            repositoryName: "owner/private",
          },
        ],
      }),
    );
    expect(leases).toEqual([`${token}-1`, `${token}-2`, `${token}-3`]);
    expect(leaseTargets).toEqual([undefined, "8116", undefined]);
    const networkActions = fake.calls
      .filter(({ environment }) => environment?.GH_TOKEN !== undefined)
      .map(({ command }) => command.split(" ").at(-1));
    expect(networkActions).toEqual(["initialize", "submodule", "lfs"]);
    expect(
      fake.calls
        .filter(({ command }) => / hooks$/.test(command))
        .every(({ environment }) => environment?.GH_TOKEN === undefined),
    ).toBe(true);
  });

  it("unshallows declared hook history through a scoped fetch lease", async () => {
    const leases: string[] = [];
    const timeline: string[] = [];
    const fake = makeSandbox([0], {
      shallow: true,
      fullHistoryNeeded: true,
      timeline,
    });

    await activate(
      fake.preparation,
      serviceLayer({ source: snapshot, leases }),
    );

    expect(timeline).toEqual(["activate", "unshallow", "hooks"]);
    expect(leases).toEqual([`${token}-1`]);
    expect(
      fake.calls.find(({ command }) => command.endsWith(" unshallow"))
        ?.environment?.GH_TOKEN,
    ).toBe(`${token}-1`);
    expect(
      fake.calls.find(({ command }) => command.endsWith(" hooks"))?.environment
        ?.GH_TOKEN,
    ).toBeUndefined();
  });

  it("unshallows a declared public source hook without a credential lease", async () => {
    const leases: string[] = [];
    const timeline: string[] = [];
    const fake = makeSandbox([0], {
      shallow: true,
      fullHistoryNeeded: true,
      timeline,
    });

    await activate(
      fake.preparation,
      serviceLayer({ source: snapshot, anonymous: true, leases }),
    );

    expect(timeline).toEqual(["activate", "unshallow-anonymous", "hooks"]);
    expect(leases).toEqual([]);
    expect(
      fake.calls.find(({ command }) => command.endsWith(" unshallow-anonymous"))
        ?.environment?.GH_TOKEN,
    ).toBeUndefined();
  });

  it("leaves anonymous LFS pointers to the user instead of failing activation", async () => {
    const leases: string[] = [];
    const fake = makeSandbox([0], { lfs: true });

    await expect(
      activate(
        fake.preparation,
        serviceLayer({ source: snapshot, anonymous: true, leases }),
      ),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    expect(leases).toEqual([]);
    expect(fake.calls.some(({ command }) => command.endsWith(" lfs"))).toBe(
      false,
    );
  });

  it("leaves Bitbucket submodules to the user without minting a checkout lease", async () => {
    const leases: string[] = [];
    const fake = makeSandbox([0], {
      modules: JSON.stringify([
        {
          key: "private",
          path: "vendor/private",
          repositoryName: "owner/private",
        },
      ]),
    });

    await expect(
      activate(
        fake.preparation,
        serviceLayer({
          source: bitbucketSnapshot,
          leases,
          privateSubmodules: [
            {
              providerRepositoryId: "8116",
              repositoryName: "owner/private",
            },
          ],
        }),
      ),
    ).resolves.toBe(SOURCE_WORKSPACE_CWD);

    expect(leases).toEqual([]);
    expect(
      fake.calls.some(({ command }) => command.endsWith(" submodule")),
    ).toBe(false);
  });

  it("leaves an identity conflict untouched and does not mint", async () => {
    const leases: string[] = [];
    const fake = makeSandbox([20]);
    await expect(
      activate(fake.preparation, serviceLayer({ source: snapshot, leases })),
    ).rejects.toBeInstanceOf(SourceWorkspaceConflict);
    expect(leases).toEqual([]);
  });
});
