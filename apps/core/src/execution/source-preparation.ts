import {
  SourceControlProviderFailure,
  SourceWorkspaceRepository,
  ThreadId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import type { SandboxFactory } from "@flue/runtime";
import { Effect, Layer, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { executionWorkspaceLogger } from "../logging.js";
import { SettingsAudit } from "../settings/audit.js";
import { SettingsService } from "../settings/service.js";
import { WorkspaceRepositoryD1 } from "../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../settings/workspace-policy/service.js";
import { SourceAuditD1 } from "../source-control/audit.js";
import { bitbucketRuntimeBroker } from "../source-control/bitbucket/runtime.js";
import { loadSourceWorkspaceConfiguration } from "../source-control/configuration.js";
import {
  GITHUB_CLI_WRAPPER_INSTALL_COMMAND,
  githubCliWrapper,
} from "../source-control/github/cli-wrapper.js";
import { GitHubRuntimeAdapterLive } from "../source-control/github/runtime-adapter.js";
import {
  SourceAuthorizationPolicyLive,
  SourceRuntimeBroker,
  SourceRuntimeBrokerLive,
  type SourceRuntimeBrokerShape,
} from "../source-control/runtime.js";
import { SourceAuthorityRepositoryD1 } from "../source-control/runtime-authority.js";
import {
  type SourceWorkspaceAssetVerification,
  type SourceWorkspacePreparationPhase,
  SourceWorkspaceService,
  SourceWorkspaceServiceWithBroker,
} from "../source-control/source-workspace.js";
import { SourceWorkspaceRepositoryD1 } from "../source-control/source-workspace-repository-d1.js";
import { withSourceCommandAdmission } from "./e2b/source-command-admission.js";
import { workspacePreparationFor } from "./workspace-preparation.js";

/**
 * Source preparation for every Execution provider: the brokered source
 * runtime, clone and setup/resume hooks, the `gh` wrapper, and source-command
 * admission on the agent's sandbox. Core runs it over a provider's raw guest.
 */

export interface SourceWorkspaceRuntimeOptions {
  readonly broker?: SourceRuntimeBrokerShape;
  readonly program?: string;
  readonly verifyAssets?: SourceWorkspaceAssetVerification;
}

export const sourceWorkspaceLayer = (
  bindings: Bindings,
  db: D1Database,
  options?: SourceWorkspaceRuntimeOptions,
) => {
  const d1 = D1Client.layer({ db });
  const workspaces = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspaces));
  const workspacePolicy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspaces,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  const authorizationPolicy = SourceAuthorizationPolicyLive.pipe(
    Layer.provide(workspacePolicy),
  );
  const githubBroker =
    options?.broker === undefined
      ? SourceRuntimeBrokerLive().pipe(
          Layer.provide(
            Layer.mergeAll(
              SourceAuthorityRepositoryD1(db),
              authorizationPolicy,
              GitHubRuntimeAdapterLive({ bindings }),
              SourceAuditD1(db),
            ),
          ),
          Layer.catchTag("ConfigError", () =>
            Layer.effect(
              SourceRuntimeBroker,
              Effect.fail(
                new SourceControlProviderFailure({
                  provider: "github",
                  retryable: false,
                }),
              ),
            ),
          ),
          Layer.catchTag("GitHubAppConfigurationInvalid", () =>
            Layer.effect(
              SourceRuntimeBroker,
              Effect.fail(
                new SourceControlProviderFailure({
                  provider: "github",
                  retryable: false,
                }),
              ),
            ),
          ),
        )
      : Layer.succeed(SourceRuntimeBroker, options.broker);
  const broker =
    options?.broker === undefined
      ? Layer.succeed(
          SourceRuntimeBroker,
          SourceRuntimeBroker.of({
            withCommandEnvironment: (
              threadId,
              actorUserId,
              request,
              callback,
              targetRepositoryId,
            ) =>
              Effect.gen(function* () {
                const source = yield* Effect.tryPromise({
                  try: () =>
                    db
                      .prepare(
                        "SELECT provider FROM thread_source_snapshot WHERE thread_id = ?",
                      )
                      .bind(threadId)
                      .first<{ provider: string }>(),
                  catch: () =>
                    new SourceControlProviderFailure({
                      provider: "bitbucket",
                      retryable: true,
                    }),
                });
                if (source?.provider === "bitbucket")
                  return yield* bitbucketRuntimeBroker(
                    db,
                    bindings,
                  ).withCommandEnvironment(
                    threadId,
                    actorUserId,
                    request,
                    callback,
                    targetRepositoryId,
                  );
                return yield* Effect.gen(function* () {
                  return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
                    threadId,
                    actorUserId,
                    request,
                    callback,
                    targetRepositoryId,
                  );
                }).pipe(Effect.provide(githubBroker));
              }),
          }),
        )
      : githubBroker;
  const deferredBroker = SourceRuntimeBroker.of({
    withCommandEnvironment: (
      threadId,
      actorUserId,
      request,
      callback,
      targetProviderRepositoryId,
    ) =>
      Effect.gen(function* () {
        return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
          threadId,
          actorUserId,
          request,
          callback,
          targetProviderRepositoryId,
        );
      }).pipe(Effect.provide(broker)),
  });
  const repository = SourceWorkspaceRepositoryD1(db);
  const configuration = loadSourceWorkspaceConfiguration(bindings);
  const workspace = SourceWorkspaceServiceWithBroker(
    deferredBroker,
    options?.program,
    options?.verifyAssets,
    configuration.shallowClone,
  ).pipe(Layer.provide(SourceWorkspaceRepositoryD1(db)));
  return {
    activation: Layer.mergeAll(workspace, repository),
    runtime: Layer.mergeAll(workspace, broker, repository),
  };
};

export const activateSourceWorkspace = (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
  sandbox: Parameters<typeof workspacePreparationFor>[0],
  runThreadHooks = true,
  options?: SourceWorkspaceRuntimeOptions,
  onPreparationPhase?: (
    phase: SourceWorkspacePreparationPhase,
  ) => Effect.Effect<void>,
  runResume = true,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SourceWorkspaceService;
      const preparation = workspacePreparationFor(sandbox);
      return yield* runThreadHooks
        ? service.activate(threadId, preparation, onPreparationPhase, {
            runResume,
          })
        : service.prepare(threadId, preparation);
    }).pipe(
      Effect.provide(sourceWorkspaceLayer(bindings, db, options).activation),
    ),
  );

/**
 * Installs the dx `gh` wrapper when the Thread owner has connected GitHub,
 * whatever the Thread's source. It runs on every agent activation and on a
 * daemon bootstrap, never on a resident wake (the wrapper is already in that
 * immutable workspace), and never blocks activation: without it `gh` is
 * merely unauthenticated.
 */
export const ensureGithubCliWrapper = async (
  db: D1Database,
  threadId: string,
  sandbox: {
    readonly commands: {
      readonly run: (
        command: string,
        options: {
          readonly envs: Record<string, string>;
          readonly timeoutMs: number;
        },
      ) => Promise<{ readonly exitCode?: number }>;
    };
  },
) => {
  try {
    const connected = await db
      .prepare(
        `SELECT 1 AS connected
           FROM threads t
           JOIN github_user_authorization a ON a.user_id = t.owner_user_id
          WHERE t.id = ? AND a.status = 'active'
            AND a.access_token_reference_id IS NOT NULL
          LIMIT 1`,
      )
      .bind(threadId)
      .first<{ connected: number }>();
    if (connected === null) return;
    const result = await sandbox.commands.run(
      GITHUB_CLI_WRAPPER_INSTALL_COMMAND,
      {
        envs: { DX_GH_WRAPPER: githubCliWrapper() },
        timeoutMs: 10_000,
      },
    );
    if ((result.exitCode ?? 0) !== 0)
      throw new Error("GitHub CLI wrapper installation failed.");
  } catch (error) {
    executionWorkspaceLogger.warn("GitHub CLI wrapper installation failed.", {
      event: "github_cli_wrapper",
      threadId,
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        1_000,
      ),
    });
  }
};

/**
 * Admits the agent's source commands (push, repository reads) through the
 * Thread's source runtime.
 */
export const withSourceRuntimeAdmission = (
  factory: SandboxFactory,
  bindings: Bindings,
  db: D1Database,
  options?: SourceWorkspaceRuntimeOptions,
): SandboxFactory => {
  const runtimeLayer = sourceWorkspaceLayer(bindings, db, options).runtime;
  return withSourceCommandAdmission(
    factory,
    (threadId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(ThreadId)(threadId);
          return yield* (yield* SourceWorkspaceRepository).findByThreadId(
            decoded,
          );
        }).pipe(Effect.provide(runtimeLayer)),
      ),
    (threadId, source, request, callback) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
            threadId,
            source.actorUserId,
            request,
            (environment) => Effect.promise(() => callback(environment)),
          );
        }).pipe(Effect.provide(runtimeLayer)),
      ),
  );
};
