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
import { bitbucketControlPlaneFor } from "../source-control/bitbucket/control-plane.js";
import { bitbucketRuntimeBroker } from "../source-control/bitbucket/runtime.js";
import { loadSourceWorkspaceConfiguration } from "../source-control/configuration.js";
import {
  GITHUB_CLI_WRAPPER_INSTALL_COMMAND,
  githubCliWrapper,
} from "../source-control/github/cli-wrapper.js";
import { readGitHubUserAccessToken } from "../source-control/github/control-plane.js";
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
import { GIT_CREDENTIAL_HELPER_PATH } from "../source-control/workspace-assets.js";
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

export const ADDITIONAL_REPOSITORIES_DIRECTORY = "/home/user/workspace/repos";
const ADDITIONAL_CLONE_TIMEOUT_MS = 300_000;

interface AdditionalRepositoryRow {
  readonly provider: string;
  readonly full_name: string;
  readonly clone_url: string;
  readonly owner_user_id: string;
}

/**
 * Directory names under `~/workspace/repos`: the repository name, or
 * `<owner>-<name>` when two additional repositories share a name.
 */
export const additionalRepositoryDirectories = (
  fullNames: ReadonlyArray<string>,
) => {
  const base = (fullName: string) => fullName.split("/").at(-1) ?? fullName;
  return fullNames.map((fullName) =>
    fullNames.filter((other) => base(other) === base(fullName)).length > 1
      ? fullName.replaceAll("/", "-")
      : base(fullName),
  );
};

/**
 * Clones each missing directory into a sibling temporary path and renames it
 * into place, so an interrupted clone never leaves a partial repository. An
 * existing directory is the user's work and is never touched. A GitHub
 * credential reaches Git only through the template's exact-repository helper.
 */
const ADDITIONAL_CLONE_COMMAND = `set -u
target="$DX_REPOSITORIES_ROOT/$DX_REPOSITORY_DIRECTORY"
test -e "$target" && exit 0
mkdir -p -- "$DX_REPOSITORIES_ROOT" || exit 1
temporary="$DX_REPOSITORIES_ROOT/.dx-clone-$DX_INVOCATION_ID"
rm -rf -- "$temporary"
if test -n "\${GH_TOKEN:-}" && test -x "$DX_GIT_HELPER"; then
  set -- -c credential.helper= -c "credential.helper=$DX_GIT_HELPER" -c credential.useHttpPath=true
else
  unset GH_TOKEN
  set -- -c credential.helper=
fi
if git "$@" -c credential.interactive=false -c protocol.file.allow=never -c protocol.ext.allow=never -c protocol.ssh.allow=never clone --quiet -- "$DX_CLONE_URL" "$temporary"; then
  mv -T -- "$temporary" "$target"
else
  status=$?
  rm -rf -- "$temporary"
  exit "$status"
fi`;

/**
 * Clones the Project's additional repositories beside the primary checkout,
 * on behalf of the Thread owner: a GitHub or Bitbucket repository uses the
 * owner's own token when they have connected that provider, and anything else
 * clones anonymously. It runs on every activation, skips existing directories, and
 * never blocks activation: a repository the owner cannot reach is logged and
 * left absent.
 */
export const cloneAdditionalRepositories = async (
  bindings: Bindings,
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
      ) => Promise<{ readonly exitCode?: number; readonly stdout?: string }>;
    };
  },
  readOwnerToken: (
    provider: "github" | "bitbucket",
    userId: string,
  ) => Promise<string> = (provider, userId) =>
    provider === "github"
      ? readGitHubUserAccessToken(bindings, db, userId)
      : bitbucketControlPlaneFor(db, bindings).then((control) =>
          control.withConnection(userId, undefined, async (token) => token),
        ),
) => {
  let rows: ReadonlyArray<AdditionalRepositoryRow>;
  try {
    rows = (
      await db
        .prepare(
          `SELECT additional.provider, additional.full_name,
                  additional.clone_url, thread.owner_user_id
             FROM threads AS thread
             JOIN project_additional_repository AS additional
               ON additional.project_id = thread.project_id
            WHERE thread.id = ?
            ORDER BY additional.position`,
        )
        .bind(threadId)
        .all<AdditionalRepositoryRow>()
    ).results;
  } catch {
    executionWorkspaceLogger.warn(
      "Additional repositories could not be read.",
      { event: "additional_repository_clone", threadId, outcome: "error" },
    );
    return;
  }
  if (rows.length === 0) return;
  const directories = additionalRepositoryDirectories(
    rows.map(({ full_name }) => full_name),
  );
  const ownerTokens = new Map<string, Promise<string | undefined>>();
  const ownerToken = (provider: "github" | "bitbucket", userId: string) => {
    const key = `${provider}:${userId}`;
    let token = ownerTokens.get(key);
    if (token === undefined) {
      token = readOwnerToken(provider, userId).catch(() => undefined);
      ownerTokens.set(key, token);
    }
    return token;
  };
  for (const [index, row] of rows.entries()) {
    const directory = directories[index] as string;
    const base = {
      DX_REPOSITORIES_ROOT: ADDITIONAL_REPOSITORIES_DIRECTORY,
      DX_REPOSITORY_DIRECTORY: directory,
      DX_CLONE_URL: row.clone_url,
      DX_INVOCATION_ID: crypto.randomUUID(),
      DX_GIT_HELPER: GIT_CREDENTIAL_HELPER_PATH,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    try {
      // Providers may reject a nonzero exit, so presence is printed.
      const present = await sandbox.commands.run(
        'if test -e "$DX_REPOSITORIES_ROOT/$DX_REPOSITORY_DIRECTORY"; then echo present; else echo absent; fi',
        { envs: base, timeoutMs: 10_000 },
      );
      if (present.stdout?.trim() !== "absent") continue;
      const token =
        row.provider === "github" || row.provider === "bitbucket"
          ? await ownerToken(row.provider, row.owner_user_id)
          : undefined;
      const result = await sandbox.commands.run(ADDITIONAL_CLONE_COMMAND, {
        envs:
          token === undefined
            ? base
            : row.provider === "github"
              ? {
                  ...base,
                  DX_SOURCE_PROVIDER: "github",
                  DX_GIT_ALLOWED_PATH: row.full_name,
                  GH_TOKEN: token,
                }
              : {
                  // Environment configuration keeps the token out of the
                  // command line; it applies only to this exact repository.
                  ...base,
                  GIT_CONFIG_COUNT: "1",
                  GIT_CONFIG_KEY_0: `http.${row.clone_url}.extraHeader`,
                  GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-token-auth:${token}`)}`,
                },
        timeoutMs: ADDITIONAL_CLONE_TIMEOUT_MS,
      });
      if ((result.exitCode ?? 0) !== 0)
        throw new Error(`git clone exited with ${result.exitCode}.`);
      executionWorkspaceLogger.info("Additional repository cloned.", {
        event: "additional_repository_clone",
        threadId,
        directory,
        authenticated: token !== undefined,
        outcome: "cloned",
      });
    } catch (error) {
      executionWorkspaceLogger.warn("Additional repository clone failed.", {
        event: "additional_repository_clone",
        threadId,
        directory,
        outcome: "error",
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          300,
        ),
      });
    }
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
