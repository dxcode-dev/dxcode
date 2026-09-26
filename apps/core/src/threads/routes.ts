import {
  ArchiveThreadExecutionUnavailableResponseSchema,
  ArchiveThreadInvalidRequestResponseSchema,
  ArchiveThreadNotFoundResponseSchema,
  ArchiveThreadParamsSchema,
  ArchiveThreadPersistenceUnavailableResponseSchema,
  ArchiveThreadRequestSchema,
  ArchiveThreadResponseSchema,
  CreateThreadInitialAdmissionUnavailableResponseSchema,
  CreateThreadInvalidRequestResponseSchema,
  CreateThreadModelRouteUnavailableResponseSchema,
  CreateThreadPersistenceUnavailableResponseSchema,
  CreateThreadPolicyDeniedResponseSchema,
  CreateThreadProjectlessForbiddenResponseSchema,
  CreateThreadProjectNotFoundResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  CreateThreadRunnerUnavailableResponseSchema,
  GetThreadInvalidRequestResponseSchema,
  GetThreadNotFoundResponseSchema,
  GetThreadParamsSchema,
  GetThreadPersistenceUnavailableResponseSchema,
  GetThreadReadinessInvalidRequestResponseSchema,
  GetThreadReadinessNotFoundResponseSchema,
  GetThreadReadinessParamsSchema,
  GetThreadReadinessPersistenceUnavailableResponseSchema,
  GetThreadReadinessResponseSchema,
  GetThreadResponseSchema,
  ListThreadsInvalidRequestResponseSchema,
  ListThreadsPersistenceUnavailableResponseSchema,
  ListThreadsQuerySchema,
  ListThreadsResponseSchema,
  PinThreadInvalidRequestResponseSchema,
  PinThreadNotFoundResponseSchema,
  PinThreadParamsSchema,
  PinThreadPersistenceUnavailableResponseSchema,
  PinThreadRequestSchema,
  PinThreadResponseSchema,
  SourceControlDeniedResponseSchema,
  SourceControlProviderFailureResponseSchema,
  type ThreadData,
  type ThreadDetailData,
  threadAgentUrl,
} from "@dx/api";
import {
  defaultThreadModelSelection,
  ModelNotServed,
  PersistenceUnavailable,
  SourceControlAccessDenied,
  SourceControlGrantId,
  SourceControlProviderFailure,
  type Thread,
  UNTITLED_THREAD_TITLE,
  type WorkspacePolicyDenied,
  WorkspaceRepository,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { dispatch } from "@flue/runtime";
import { Effect, Layer, Match, Option, Result, Schema } from "effect";
import { Hono } from "hono";
import { DxAgent } from "../agents/dx-agent.js";
import { ExecutionWorkspaces } from "../execution/execution-workspaces.js";
import {
  loadRunnerProfileCatalog,
  selectRunnerProfile,
} from "../execution/runner-profiles/catalog.js";
import { resolveExecutionRunnerProfile } from "../execution/runner-profiles/execution.js";
import { readExecutionWorkspaceReadiness } from "../execution/workspace-readiness.js";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../http/request-decoding.js";
import type { AppEnv } from "../http/types.js";
import { StartupTraceCorrelation } from "../observability/startup-phase.js";
import {
  recordStartupPhases,
  scheduleStartupPersistence,
  startupObservation,
  startupServerTiming,
} from "../observability/startup-runtime.js";
import { submissionStartupObservations } from "../observability/submission-startup.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { ProjectRepositoryD1 } from "../projects/repository-d1.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { PersonalAgentInstructionsRepositoryD1 } from "../settings/agent-instructions/repository-d1.js";
import { SettingsAudit } from "../settings/audit.js";
import { EnvironmentVariableRepositoryD1 } from "../settings/environment-variables/repository-d1.js";
import { signingBackendCapabilities } from "../settings/keys/backend.js";
import { resolveMcpAgentConnections } from "../settings/mcp-servers/execution.js";
import { McpServerRepositoryD1 } from "../settings/mcp-servers/repository-d1.js";
import { resolveSelectionForUser } from "../settings/model-routing/submission.js";
import { resolvePluginAgentData } from "../settings/plugins/execution.js";
import { PluginRepositoryD1 } from "../settings/plugins/repository-d1.js";
import { PluginService } from "../settings/plugins/service.js";
import { projectDefaultsLayersFor } from "../settings/project-defaults/routes.js";
import { ProjectDefaultsService } from "../settings/project-defaults/service.js";
import { SettingsService } from "../settings/service.js";
import { resolveSkillAgentData } from "../settings/skills/execution.js";
import { SkillRepositoryD1 } from "../settings/skills/repository-d1.js";
import { SkillService } from "../settings/skills/service.js";
import { WorkspaceRepositoryD1 } from "../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../settings/workspace-policy/service.js";
import { authorizeProjectSource } from "../source-control/admission.js";
import {
  readThreadListProjection,
  threadListItem,
} from "./list-projection-d1.js";
import { ThreadRepositoryD1 } from "./repository-d1.js";
import { ThreadService } from "./service.js";

class InvalidThreadRequest extends Schema.TaggedError<InvalidThreadRequest>()(
  "InvalidThreadRequest",
  {},
) {}

class ThreadArchiveExecutionUnavailable extends Schema.TaggedError<ThreadArchiveExecutionUnavailable>()(
  "ThreadArchiveExecutionUnavailable",
  {},
) {}

class ThreadInitialAdmissionUnavailable extends Schema.TaggedError<ThreadInitialAdmissionUnavailable>()(
  "ThreadInitialAdmissionUnavailable",
  {},
) {}

const threadData = (thread: Thread): ThreadData => ({
  id: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  visibility: thread.visibility ?? "private",
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  lastActivityAt: thread.lastActivityAt,
  activityStatus: thread.activityStatus,
  lifecycleState: thread.lifecycleState,
  pinnedAt: thread.pinnedAt,
  agentUrl: threadAgentUrl(thread.id),
});

export const threadDetailData = Effect.fn("threadDetailData")(function* (
  binding: unknown,
  db: D1Database,
  thread: Thread,
) {
  const [mcpConnections, skills, plugins, executionWorkspace] =
    yield* Effect.all(
      [
        resolveMcpAgentConnections(binding, thread.id).pipe(
          Effect.mapError(
            () =>
              new PersistenceUnavailable({ operation: "resolve MCP policy" }),
          ),
        ),
        resolveSkillAgentData(binding, thread).pipe(
          Effect.mapError(
            () =>
              new PersistenceUnavailable({
                operation: "resolve skill snapshot",
              }),
          ),
        ),
        resolvePluginAgentData(binding, thread).pipe(
          Effect.mapError(
            () =>
              new PersistenceUnavailable({
                operation: "resolve plugin snapshot",
              }),
          ),
        ),
        Effect.tryPromise({
          try: () => readExecutionWorkspaceReadiness(db, thread.id),
          catch: () =>
            new PersistenceUnavailable({
              operation: "resolve execution workspace readiness",
            }),
        }),
      ],
      { concurrency: 4 },
    );
  return {
    ...threadData(thread),
    agentInitialization: {
      personalInstructions: thread.agentInstructions.content,
      settingsRevision: thread.agentInstructions.revision,
      settingsVersion: thread.agentInstructions.version,
      selection: thread.selection,
      mcpConnections,
      plugins,
      skills,
    },
    executionWorkspace,
  } satisfies ThreadDetailData;
});

const threadServiceLayer = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const repositories = Layer.mergeAll(
    ProjectRepositoryD1,
    ThreadRepositoryD1,
    PersonalAgentInstructionsRepositoryD1,
    workspace,
  ).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const policy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  const skillService = SkillService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SkillRepositoryD1(db),
        McpServerRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  const pluginService = PluginService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        PluginRepositoryD1(db),
        EnvironmentVariableRepositoryD1(db),
        McpServerRepositoryD1(db),
        policy,
        SettingsAudit.layer,
      ),
    ),
  );
  const threads = ThreadService.layer.pipe(
    Layer.provide(Layer.mergeAll(repositories, skillService, pluginService)),
  );
  return Layer.merge(threads, policy);
};

type InitialThreadDispatcher = (
  request: Parameters<typeof dispatch>[1],
) => ReturnType<typeof dispatch>;

const dispatchInitialThreadMessage: InitialThreadDispatcher = (request) =>
  dispatch(DxAgent, request);

export const resolveCreationResponseDetail = <
  Detail,
  DetailError,
  DetailRequirements,
  AdmissionError,
  AdmissionRequirements,
>(
  detail: Effect.Effect<Detail, DetailError, DetailRequirements>,
  initialAdmission?: Effect.Effect<
    unknown,
    AdmissionError,
    AdmissionRequirements
  >,
): Effect.Effect<
  Detail,
  DetailError | AdmissionError,
  DetailRequirements | AdmissionRequirements
> => {
  if (initialAdmission === undefined) return detail;
  return Effect.all(
    [Effect.result(detail), Effect.result(initialAdmission)] as const,
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap(([detailResult, admissionResult]) =>
      Result.isFailure(detailResult)
        ? Effect.fail<DetailError | AdmissionError>(detailResult.failure)
        : Result.isFailure(admissionResult)
          ? Effect.fail<DetailError | AdmissionError>(admissionResult.failure)
          : Effect.succeed(detailResult.success),
    ),
  );
};

export const createThreadRoutes = (
  dispatchInitialMessage: InitialThreadDispatcher = dispatchInitialThreadMessage,
) => {
  const threadRoutes = new Hono<AppEnv>();

  threadRoutes.post("/", async (context) => {
    const requestId = context.get("requestId");
    const startedAt = Date.now();
    let requestAdmittedAt = startedAt;
    let sourceAuthorizedAt = startedAt;
    let threadPersistedAt = startedAt;
    const operation = Effect.gen(function* () {
      const input = yield* decodeJsonBody(
        context.req,
        CreateThreadRequestSchema,
        () => new InvalidThreadRequest(),
      );
      requestAdmittedAt = Date.now();
      const db = yield* decodeD1Binding(context.env.DB);
      const workspace = WorkspaceRepositoryD1(db).pipe(
        Layer.provide(D1Client.layer({ db })),
      );
      const serviceLayer = threadServiceLayer(db);
      const principal = context.get("principal");
      const requestedThreadId = input.threadId;
      const existingThread =
        requestedThreadId === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const service = yield* ThreadService;
              return yield* service
                .get(principal, requestedThreadId)
                .pipe(
                  Effect.catchTag("ThreadNotFound", () =>
                    Effect.succeed(undefined),
                  ),
                );
            }).pipe(Effect.provide(serviceLayer));
      const thread =
        existingThread ??
        (yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () =>
              resolveSelectionForUser(
                context.env,
                principal.userId,
                input.selection ?? defaultThreadModelSelection(),
              ),
            catch: (cause) => {
              if (cause instanceof ModelNotServed) return cause;
              return PersistenceUnavailable.new(
                { operation: "thread.resolveModelSelection" },
                cause,
              );
            },
          });
          const projectId = input.projectId;
          const requestedRunnerProfileId = input.runnerProfileId;
          const runnerProfileId =
            requestedRunnerProfileId === undefined
              ? undefined
              : yield* Effect.gen(function* () {
                  const catalog = yield* loadRunnerProfileCatalog(context.env);
                  const profile = yield* selectRunnerProfile(
                    catalog,
                    requestedRunnerProfileId,
                  );
                  const policy = yield* WorkspacePolicyService;
                  yield* policy.evaluateForUser(principal.userId, {
                    kind: "execution.admit",
                    runnerProfileId: profile.id,
                    runnerAdapter: profile.adapter,
                  });
                  return profile.id;
                });
          const project =
            projectId === undefined
              ? yield* Effect.gen(function* () {
                  const membership = yield* Effect.gen(function* () {
                    const repository = yield* WorkspaceRepository;
                    return yield* repository.findByUser(principal.userId);
                  }).pipe(Effect.provide(workspace));
                  const catalog = yield* loadRunnerProfileCatalog(context.env);
                  const signingCapabilities = yield* signingBackendCapabilities(
                    context.env,
                  );
                  const defaults = yield* ProjectDefaultsService;
                  const snapshot = yield* defaults.snapshotForProject(
                    principal,
                    catalog,
                    {
                      ...(Option.isNone(membership)
                        ? {}
                        : {
                            workspaceSlug: membership.value.workspace.shortName,
                          }),
                      publicCodeEnabled: false,
                      deploymentSigningAvailable: signingCapabilities.some(
                        ({ source, state }) =>
                          source === "deployment" && state === "available",
                      ),
                    },
                  );
                  return { kind: "projectless" as const, snapshot };
                }).pipe(Effect.provide(projectDefaultsLayersFor(db)))
              : { kind: "project" as const, projectId };
          const authorizedSource =
            projectId === undefined
              ? undefined
              : yield* Effect.tryPromise({
                  try: () =>
                    authorizeProjectSource({
                      db,
                      bindings: context.env,
                      projectId,
                      ownerUserId: principal.userId,
                      waitUntil: (promise) =>
                        context.executionCtx.waitUntil(promise),
                    }),
                  catch: (cause) =>
                    cause instanceof SourceControlAccessDenied ||
                    cause instanceof SourceControlProviderFailure
                      ? cause
                      : new SourceControlProviderFailure({
                          provider: "github",
                          retryable: true,
                        }),
                });
          sourceAuthorizedAt = Date.now();
          const source =
            projectId === undefined || authorizedSource === undefined
              ? undefined
              : authorizedSource.kind === "anonymous"
                ? {
                    kind: "pending" as const,
                    intent: {
                      version: 1 as const,
                      projectId,
                      bindingRevision: authorizedSource.bindingRevision,
                      provider: authorizedSource.provider,
                      repositoryName: authorizedSource.repositoryName,
                      cloneUrl: authorizedSource.cloneUrl,
                    },
                  }
                : {
                    kind: "finalized" as const,
                    snapshot: {
                      version: 2 as const,
                      projectId,
                      bindingRevision: authorizedSource.bindingRevision,
                      provider: authorizedSource.provider,
                      repositoryName: authorizedSource.fullName,
                      cloneUrl: authorizedSource.cloneUrl,
                      defaultBranch: authorizedSource.defaultBranch,
                      sourceRevision: authorizedSource.commitSha,
                      initialRef: `refs/heads/${authorizedSource.defaultBranch}`,
                    },
                    authority: {
                      grantId: Schema.decodeUnknownSync(SourceControlGrantId)(
                        authorizedSource.grantId,
                      ),
                      installationId: authorizedSource.installationId,
                      providerWorkspaceId: authorizedSource.providerWorkspaceId,
                      providerRepositoryId:
                        authorizedSource.providerRepositoryId,
                      authorizationEpoch: authorizedSource.authorizationEpoch,
                      installationEpoch: authorizedSource.installationEpoch,
                      policyRevision: authorizedSource.policyRevision,
                      privateSubmoduleRepositoryIds: [],
                    },
                  };
          const service = yield* ThreadService;
          return yield* service
            .create(
              principal,
              project,
              input.title ?? UNTITLED_THREAD_TITLE,
              input.selection,
              source,
              requestedThreadId,
              runnerProfileId,
            )
            .pipe(
              Effect.catchTag("PersistenceUnavailable", (failure) =>
                requestedThreadId === undefined
                  ? Effect.fail(failure)
                  : service
                      .get(principal, requestedThreadId)
                      .pipe(
                        Effect.catchTag("ThreadNotFound", () =>
                          Effect.fail(failure),
                        ),
                      ),
              ),
            );
        }).pipe(Effect.provide(serviceLayer)));
      threadPersistedAt = Date.now();
      const initialMessage = input.initialMessage;
      const detail = yield* resolveCreationResponseDetail(
        threadDetailData(context.env.DB, db, thread),
        initialMessage === undefined
          ? undefined
          : resolveExecutionRunnerProfile(context.env, thread.id).pipe(
              Effect.catchTag("ExecutionRunnerProfileUnavailable", () =>
                Effect.fail(new ThreadInitialAdmissionUnavailable()),
              ),
            ),
      );
      let initialSubmission: { readonly submissionId: string } | undefined;
      if (initialMessage !== undefined) {
        const receipt = yield* Effect.tryPromise({
          try: () =>
            dispatchInitialMessage({
              id: thread.id,
              uid: null,
              initialData: detail.agentInitialization,
              message: {
                kind: "user",
                body: initialMessage.body,
                attachments: [...initialMessage.attachments],
              },
              idempotencyKey: "initial",
            }),
          catch: () => new ThreadInitialAdmissionUnavailable(),
        });
        initialSubmission = { submissionId: receipt.submissionId };
        const observations = submissionStartupObservations(
          requestId,
          thread.id,
          receipt,
          startedAt,
        );
        if (observations !== undefined)
          yield* Effect.promise(() =>
            scheduleStartupPersistence(
              () => context.executionCtx,
              recordStartupPhases(context.env.DB, observations),
            ),
          );
      }
      const body = yield* Schema.encodeUnknownEffect(
        CreateThreadResponseSchema,
      )({
        status: "success",
        data: detail,
        ...(initialSubmission === undefined ? {} : { initialSubmission }),
      });
      return { body, threadId: thread.id };
    });

    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) {
      await scheduleRealtimeInvalidation(
        () => context.executionCtx,
        context.env,
        result.success.threadId,
        "thread.invalidated",
      );
      const responseReadyAt = Date.now();
      const decodedCorrelation = Schema.decodeUnknownResult(
        StartupTraceCorrelation,
      )({
        journey: "thread_create",
        requestId,
        threadId: result.success.threadId,
      });
      if (Result.isFailure(decodedCorrelation))
        return context.json(result.success.body, 201);
      const correlation = decodedCorrelation.success;
      const observations = [
        startupObservation(
          correlation,
          "request_admitted",
          startedAt,
          requestAdmittedAt,
        ),
        startupObservation(
          correlation,
          "source_authorized",
          startedAt,
          sourceAuthorizedAt,
        ),
        startupObservation(
          correlation,
          "thread_persisted",
          startedAt,
          threadPersistedAt,
        ),
        startupObservation(
          correlation,
          "response_ready",
          startedAt,
          responseReadyAt,
        ),
      ];
      context.header("Server-Timing", startupServerTiming(observations));
      await scheduleStartupPersistence(
        () => context.executionCtx,
        recordStartupPhases(context.env.DB, observations),
      );
      return context.json(result.success.body, 201);
    }

    return Match.value(result.failure).pipe(
      Match.tags({
        InvalidThreadRequest: () =>
          context.json(
            Schema.encodeUnknownSync(CreateThreadInvalidRequestResponseSchema)({
              status: "error",
              data: {
                code: "INVALID_REQUEST",
                message: "Request validation failed.",
                requestId,
              },
            }),
            400,
          ),
        ProjectNotFound: () =>
          context.json(
            Schema.encodeUnknownSync(CreateThreadProjectNotFoundResponseSchema)(
              {
                status: "error",
                data: {
                  code: "PROJECT_NOT_FOUND",
                  message: "Project not found.",
                  requestId,
                },
              },
            ),
            404,
          ),
        ModelNotServed: (failure: ModelNotServed) =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadModelRouteUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "MODEL_NOT_SERVED",
                message: "The selected model is not currently served.",
                requestId,
                model: failure.model,
                reason: failure.reason,
              },
            }),
            422,
          ),
        ThreadInitialAdmissionUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadInitialAdmissionUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "INITIAL_ADMISSION_UNAVAILABLE",
                message:
                  "The initial prompt could not be accepted. Please retry.",
                requestId,
              },
            }),
            503,
          ),
        WorkspacePolicyDenied: (denial: WorkspacePolicyDenied) =>
          context.json(
            Schema.encodeUnknownSync(CreateThreadPolicyDeniedResponseSchema)({
              status: "error",
              data: {
                code: "WORKSPACE_POLICY_DENIED",
                message: "Workspace policy does not allow this Thread.",
                requestId,
                reason: denial.reason,
              },
            }),
            403,
          ),
        ProjectPolicyForbidden: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadProjectlessForbiddenResponseSchema,
            )({
              status: "error",
              data: {
                code: "PROJECT_CREATION_FORBIDDEN",
                message: "Workspace policy does not allow this project.",
                requestId,
              },
            }),
            403,
          ),
        SettingsScopeForbidden: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadProjectlessForbiddenResponseSchema,
            )({
              status: "error",
              data: {
                code: "PROJECT_CREATION_FORBIDDEN",
                message: "Workspace policy does not allow this project.",
                requestId,
              },
            }),
            403,
          ),
        RunnerProfileUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadRunnerUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "RUNNER_PROFILE_UNAVAILABLE",
                message: "The selected runner profile is unavailable.",
                requestId,
              },
            }),
            409,
          ),
        RunnerProfileConfigurationUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Persistence is temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
        PersonalAccountNotFound: (error) => {
          throw error;
        },
        PersistenceUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Persistence is temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
        SourceControlAccessDenied: (failure) =>
          context.json(
            Schema.encodeUnknownSync(SourceControlDeniedResponseSchema)({
              status: "error",
              data: {
                code: "SOURCE_AUTHORIZATION_DENIED",
                message:
                  "Source access requires action before this operation can continue.",
                requestId,
                reason: failure.reason,
                action: failure.action,
              },
            }),
            409,
          ),
        SourceControlProviderFailure: (failure) =>
          context.json(
            Schema.encodeUnknownSync(
              SourceControlProviderFailureResponseSchema,
            )({
              status: "error",
              data: {
                code: "SOURCE_PROVIDER_UNAVAILABLE",
                message: "Source authorization could not be confirmed.",
                requestId,
                retryable: failure.retryable,
              },
            }),
            503,
          ),
        D1BindingUnavailable: (error) => {
          throw error;
        },
        ConfigError: (error) => {
          throw error;
        },
        SchemaError: (error) => {
          throw error;
        },
        SettingsMembershipInvariantViolation: (error) => {
          throw error;
        },
      }),
      Match.exhaustive,
    );
  });

  threadRoutes.get("/", async (context) => {
    const requestId = context.get("requestId");
    const operation = Effect.gen(function* () {
      const query = yield* decodeRequestInput(
        ListThreadsQuerySchema,
        context.req.query(),
        () => new InvalidThreadRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const page = yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.list(context.get("principal"), query.projectId, {
          cursor: query.cursor,
          limit: query.limit,
          lifecycleState: query.lifecycleState,
        });
      }).pipe(Effect.provide(threadServiceLayer(db)));
      const projection = yield* Effect.tryPromise({
        try: () =>
          readThreadListProjection(
            db,
            page.items.map(({ id }) => id),
          ),
        catch: (cause) =>
          PersistenceUnavailable.new(
            { operation: "thread.listProjection" },
            cause,
          ),
      });
      return yield* Schema.encodeUnknownEffect(ListThreadsResponseSchema)({
        status: "success",
        data: {
          items: page.items.map((thread) =>
            threadListItem(thread, projection.get(thread.id)),
          ),
          nextCursor: page.nextCursor,
        },
      });
    });

    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) return context.json(result.success, 200);

    return Match.value(result.failure).pipe(
      Match.tags({
        InvalidThreadRequest: () =>
          context.json(
            Schema.encodeUnknownSync(ListThreadsInvalidRequestResponseSchema)({
              status: "error",
              data: {
                code: "INVALID_REQUEST",
                message: "Request validation failed.",
                requestId,
              },
            }),
            400,
          ),
        InvalidPageCursor: () =>
          context.json(
            Schema.encodeUnknownSync(ListThreadsInvalidRequestResponseSchema)({
              status: "error",
              data: {
                code: "INVALID_REQUEST",
                message: "Request validation failed.",
                requestId,
              },
            }),
            400,
          ),
        PersistenceUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              ListThreadsPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Persistence is temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
        D1BindingUnavailable: (error) => {
          throw error;
        },
        ConfigError: (error) => {
          throw error;
        },
        SchemaError: (error) => {
          throw error;
        },
      }),
      Match.exhaustive,
    );
  });

  threadRoutes.patch("/:threadId/pin", async (context) => {
    const requestId = context.get("requestId");
    const operation = Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        PinThreadParamsSchema,
        { threadId: context.req.param("threadId") },
        () => new InvalidThreadRequest(),
      );
      const body = yield* decodeJsonBody(
        context.req,
        PinThreadRequestSchema,
        () => new InvalidThreadRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const thread = yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.setPinned(
          context.get("principal"),
          params.threadId,
          body.pinned,
        );
      }).pipe(Effect.provide(threadServiceLayer(db)));
      yield* Effect.promise(() =>
        scheduleRealtimeInvalidation(
          () => context.executionCtx,
          context.env,
          thread.id,
          "thread.invalidated",
        ),
      );
      return yield* Schema.encodeUnknownEffect(PinThreadResponseSchema)({
        status: "success",
        data: threadData(thread),
      });
    });
    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) return context.json(result.success, 200);
    return Match.value(result.failure).pipe(
      Match.tags({
        InvalidThreadRequest: () =>
          context.json(
            Schema.encodeUnknownSync(PinThreadInvalidRequestResponseSchema)({
              status: "error",
              data: {
                code: "INVALID_REQUEST",
                message: "Request validation failed.",
                requestId,
              },
            }),
            400,
          ),
        ThreadNotFound: () =>
          context.json(
            Schema.encodeUnknownSync(PinThreadNotFoundResponseSchema)({
              status: "error",
              data: {
                code: "THREAD_NOT_FOUND",
                message: "Thread was not found.",
                requestId,
              },
            }),
            404,
          ),
        PersistenceUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              PinThreadPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Persistence is temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
        D1BindingUnavailable: (error) => {
          throw error;
        },
        ConfigError: (error) => {
          throw error;
        },
        SchemaError: (error) => {
          throw error;
        },
      }),
      Match.exhaustive,
    );
  });

  threadRoutes.patch("/:threadId/archive", async (context) => {
    const requestId = context.get("requestId");
    const operation = Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        ArchiveThreadParamsSchema,
        { threadId: context.req.param("threadId") },
        () => new InvalidThreadRequest(),
      );
      const body = yield* decodeJsonBody(
        context.req,
        ArchiveThreadRequestSchema,
        () => new InvalidThreadRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const thread = yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.setArchived(
          context.get("principal"),
          params.threadId,
          body.archived,
        );
      }).pipe(Effect.provide(threadServiceLayer(db)));
      yield* Effect.promise(() =>
        scheduleRealtimeInvalidation(
          () => context.executionCtx,
          context.env,
          thread.id,
          "thread.invalidated",
        ),
      );
      if (body.archived) {
        yield* Effect.tryPromise({
          try: () => ExecutionWorkspaces.pause(thread.id),
          catch: () => new ThreadArchiveExecutionUnavailable(),
        });
      }
      return yield* Schema.encodeUnknownEffect(ArchiveThreadResponseSchema)({
        status: "success",
        data: threadData(thread),
      });
    });
    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) return context.json(result.success, 200);
    return Match.value(result.failure).pipe(
      Match.tags({
        InvalidThreadRequest: () =>
          context.json(
            Schema.encodeUnknownSync(ArchiveThreadInvalidRequestResponseSchema)(
              {
                status: "error",
                data: {
                  code: "INVALID_REQUEST",
                  message: "Request validation failed.",
                  requestId,
                },
              },
            ),
            400,
          ),
        ThreadNotFound: () =>
          context.json(
            Schema.encodeUnknownSync(ArchiveThreadNotFoundResponseSchema)({
              status: "error",
              data: {
                code: "THREAD_NOT_FOUND",
                message: "Thread was not found.",
                requestId,
              },
            }),
            404,
          ),
        ThreadArchiveExecutionUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              ArchiveThreadExecutionUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "THREAD_ARCHIVE_UNAVAILABLE",
                message:
                  "The Thread was archived, but its sandbox could not be stopped.",
                requestId,
              },
            }),
            503,
          ),
        PersistenceUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              ArchiveThreadPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Persistence is temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
        D1BindingUnavailable: (error) => {
          throw error;
        },
        ConfigError: (error) => {
          throw error;
        },
        SchemaError: (error) => {
          throw error;
        },
      }),
      Match.exhaustive,
    );
  });

  threadRoutes.get("/:threadId/readiness", async (context) => {
    const requestId = context.get("requestId");
    const operation = Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        GetThreadReadinessParamsSchema,
        { threadId: context.req.param("threadId") },
        () => new InvalidThreadRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.get(context.get("principal"), params.threadId);
      }).pipe(Effect.provide(threadServiceLayer(db)));
      const readiness = yield* Effect.tryPromise({
        try: () => readExecutionWorkspaceReadiness(db, params.threadId),
        catch: (cause) =>
          PersistenceUnavailable.new({ operation: "thread.readiness" }, cause),
      });
      return yield* Schema.encodeUnknownEffect(
        GetThreadReadinessResponseSchema,
      )({ status: "success", data: readiness });
    });
    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) return context.json(result.success, 200);
    return Match.value(result.failure).pipe(
      Match.tags({
        InvalidThreadRequest: () =>
          context.json(
            Schema.encodeUnknownSync(
              GetThreadReadinessInvalidRequestResponseSchema,
            )({
              status: "error",
              data: {
                code: "INVALID_REQUEST",
                message: "Request validation failed.",
                requestId,
              },
            }),
            400,
          ),
        ThreadNotFound: () =>
          context.json(
            Schema.encodeUnknownSync(GetThreadReadinessNotFoundResponseSchema)({
              status: "error",
              data: {
                code: "THREAD_NOT_FOUND",
                message: "Thread not found.",
                requestId,
              },
            }),
            404,
          ),
        PersistenceUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              GetThreadReadinessPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Persistence is temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
        D1BindingUnavailable: (error) => {
          throw error;
        },
        ConfigError: (error) => {
          throw error;
        },
        SchemaError: (error) => {
          throw error;
        },
      }),
      Match.exhaustive,
    );
  });

  threadRoutes.get("/:threadId", async (context) => {
    const requestId = context.get("requestId");
    const operation = Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        GetThreadParamsSchema,
        { threadId: context.req.param("threadId") },
        () => new InvalidThreadRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const thread = yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.get(context.get("principal"), params.threadId);
      }).pipe(Effect.provide(threadServiceLayer(db)));
      const detail = yield* threadDetailData(context.env.DB, db, thread);
      return yield* Schema.encodeUnknownEffect(GetThreadResponseSchema)({
        status: "success",
        data: detail,
      });
    });

    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) return context.json(result.success, 200);

    return Match.value(result.failure).pipe(
      Match.tags({
        InvalidThreadRequest: () =>
          context.json(
            Schema.encodeUnknownSync(GetThreadInvalidRequestResponseSchema)({
              status: "error",
              data: {
                code: "INVALID_REQUEST",
                message: "Request validation failed.",
                requestId,
              },
            }),
            400,
          ),
        ThreadNotFound: () =>
          context.json(
            Schema.encodeUnknownSync(GetThreadNotFoundResponseSchema)({
              status: "error",
              data: {
                code: "THREAD_NOT_FOUND",
                message: "Thread not found.",
                requestId,
              },
            }),
            404,
          ),
        PersistenceUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              GetThreadPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Persistence is temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
        D1BindingUnavailable: (error) => {
          throw error;
        },
        ConfigError: (error) => {
          throw error;
        },
        SchemaError: (error) => {
          throw error;
        },
      }),
      Match.exhaustive,
    );
  });

  return threadRoutes;
};

export const threadRoutes = createThreadRoutes();
