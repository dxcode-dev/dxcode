import {
  ArchiveThreadExecutionUnavailableResponseSchema,
  ArchiveThreadInvalidRequestResponseSchema,
  ArchiveThreadNotFoundResponseSchema,
  ArchiveThreadParamsSchema,
  ArchiveThreadPersistenceUnavailableResponseSchema,
  ArchiveThreadRequestSchema,
  ArchiveThreadResponseSchema,
  CreateThreadAlreadyStartedResponseSchema,
  CreateThreadInitialAdmissionUnavailableResponseSchema,
  CreateThreadInitialMessageRejectedResponseSchema,
  CreateThreadInitialMessageTooLargeResponseSchema,
  CreateThreadInitialSubmissionConflictResponseSchema,
  CreateThreadInvalidRequestResponseSchema,
  CreateThreadModelRouteUnavailableResponseSchema,
  CreateThreadOrbUnavailableResponseSchema,
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
  UpdateThreadInvalidRequestResponseSchema,
  UpdateThreadNotFoundResponseSchema,
  UpdateThreadParamsSchema,
  UpdateThreadPersistenceUnavailableResponseSchema,
  UpdateThreadRequestSchema,
  UpdateThreadResponseSchema,
  withMessageAuthor,
} from "@dx/api";
import {
  defaultThreadModelSelection,
  isThreadTitlePending,
  ModelNotServed,
  type PageCursor,
  PersistenceUnavailable,
  type ProjectId,
  type RunnerProfileId,
  SourceControlAccessDenied,
  SourceControlGrantId,
  SourceControlProviderFailure,
  type Thread,
  type ThreadColor,
  type ThreadExecutionPin,
  type ThreadId,
  UNTITLED_THREAD_TITLE,
  type UserId,
  type WorkspacePolicyDenied,
  WorkspaceRepository,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { dispatch, FlueError, getAgentInstance } from "@flue/runtime";
import { Effect, Layer, Match, Option, Result, Schema } from "effect";
import { Hono } from "hono";
import * as v from "valibot";
import { DxAgent } from "../agents/dx-agent.js";
import { DxAgentInitialDataSchema } from "../agents/dx-agent-initial-data.js";
import {
  linkMessageAttachments,
  MessageAttachmentsRejected,
  messageAttachmentBody,
  resolveMessageAttachments,
} from "../attachments/message.js";
import { currentOrbTemplateRecipe } from "../execution/e2b/team-templates.js";
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
import { threadPersistenceLogger } from "../logging.js";
import { StartupTraceCorrelation } from "../observability/startup-phase.js";
import {
  recordStartupPhases,
  scheduleStartupPersistence,
  startupObservation,
  startupServerTiming,
} from "../observability/startup-runtime.js";
import { submissionStartupObservations } from "../observability/submission-startup.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import {
  OrbUnavailable,
  resolveThreadExecutionPin,
} from "../plugins/execution/orb-providers.js";
import { ProjectRepositoryD1 } from "../projects/repository-d1.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { PersonalAgentInstructionsRepositoryD1 } from "../settings/agent-instructions/repository-d1.js";
import { SettingsAudit } from "../settings/audit.js";
import { EnvironmentVariableRepositoryD1 } from "../settings/environment-variables/repository-d1.js";
import { signingBackendCapabilities } from "../settings/keys/backend.js";
import {
  resolveMcpAgentConnections,
  resolveMcpAgentConnectionsFor,
} from "../settings/mcp-servers/execution.js";
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
import { scheduleThreadSearchIndex } from "../thread-search/enqueue.js";
import {
  threadSharingDecorations,
  threadSharingDetail,
  userIdentity,
} from "../thread-sharing/service.js";
import {
  type DxTitleAgentRunner,
  dxTitleAgentApplies,
  runDxTitleAgent,
} from "./dx-title-agent.js";
import {
  readInboundMessages,
  readParentColors,
  readThreadChildCounts,
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

// Flue's permanent refusals of a first message: retrying it unchanged fails
// the same way, so none of them answers "Please retry".
class InitialMessageRejected extends Schema.TaggedError<InitialMessageRejected>()(
  "InitialMessageRejected",
  {},
) {}

class InitialMessageTooLarge extends Schema.TaggedError<InitialMessageTooLarge>()(
  "InitialMessageTooLarge",
  {},
) {}

class InitialSubmissionConflict extends Schema.TaggedError<InitialSubmissionConflict>()(
  "InitialSubmissionConflict",
  {},
) {}

class ThreadAlreadyStarted extends Schema.TaggedError<ThreadAlreadyStarted>()(
  "ThreadAlreadyStarted",
  {},
) {}

const initialDispatchFailure = (cause: unknown) => {
  if (cause instanceof FlueError)
    switch (cause.type) {
      case "invalid_request":
        return new InitialMessageRejected();
      case "input_too_large":
        return new InitialMessageTooLarge();
      case "submission_conflict":
        return new InitialSubmissionConflict();
      case "agent_instance_exists":
        return new ThreadAlreadyStarted();
    }
  return new ThreadInitialAdmissionUnavailable();
};

/** A child's parent's chosen color, which it shows until it has its own. */
/** How many of a root's children its list item carries. */
const CHILDREN_PER_ROOT = 100;

const parentColorField = (
  parentColors: ReadonlyMap<ThreadId, ThreadColor>,
  thread: Pick<Thread, "parentThreadId">,
) => {
  const color =
    thread.parentThreadId === undefined
      ? undefined
      : parentColors.get(thread.parentThreadId);
  return color === undefined ? {} : { parentColor: color };
};

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
  ...(thread.color === undefined ? {} : { color: thread.color }),
  ...(isThreadTitlePending(thread) ? { titlePending: true } : {}),
  agentUrl: threadAgentUrl(thread.id),
  ...(thread.parentThreadId === undefined
    ? {}
    : { parentThreadId: thread.parentThreadId }),
});

/**
 * Thread detail for a member of a shared Thread: the owner's personal agent
 * instructions, skill instructions, MCP endpoints, and plugins stay private.
 * The agent still runs with them; the server supplies them (see
 * attributeSubmission).
 */
const withoutOwnerConfiguration = <
  Detail extends Pick<ThreadDetailData, "agentInitialization">,
>(
  detail: Detail,
): Detail => ({
  ...detail,
  agentInitialization: {
    ...detail.agentInitialization,
    personalInstructions: "",
    mcpConnections: [],
    plugins: [],
    skills: [],
  },
});

/** A Thread that was just created: no workspace yet and no messages. */
const NEW_THREAD_WORKSPACE = { ready: false, preparationStatus: null };

export const threadDetailData = Effect.fn("threadDetailData")(function* (
  binding: unknown,
  db: D1Database,
  thread: Thread,
  /** Creation resolves the detail before it inserts the Thread's row. */
  unpersisted = false,
) {
  const [
    mcpConnections,
    skills,
    plugins,
    executionWorkspace,
    parentColors,
    inboundMessages,
  ] = yield* Effect.all(
    [
      (unpersisted
        ? resolveMcpAgentConnectionsFor(
            binding,
            thread.ownerUserId,
            thread.projectId,
          )
        : resolveMcpAgentConnections(binding, thread.id)
      ).pipe(
        Effect.mapError(
          () => new PersistenceUnavailable({ operation: "resolve MCP policy" }),
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
      unpersisted
        ? Effect.succeed(NEW_THREAD_WORKSPACE)
        : Effect.tryPromise({
            try: () => readExecutionWorkspaceReadiness(db, thread.id),
            catch: () =>
              new PersistenceUnavailable({
                operation: "resolve execution workspace readiness",
              }),
          }),
      Effect.tryPromise({
        try: () =>
          readParentColors(
            db,
            thread.parentThreadId === undefined ? [] : [thread.parentThreadId],
          ),
        catch: () =>
          new PersistenceUnavailable({
            operation: "resolve parent Thread color",
          }),
      }),
      unpersisted
        ? Effect.succeed([])
        : Effect.tryPromise({
            try: () => readInboundMessages(db, thread.id),
            catch: () =>
              new PersistenceUnavailable({
                operation: "resolve inbound Thread messages",
              }),
          }),
    ],
    { concurrency: 4 },
  );
  return {
    ...threadData(thread),
    ...parentColorField(parentColors, thread),
    ...(inboundMessages.length === 0 ? {} : { inboundMessages }),
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

/**
 * Starts the Thread's agent Durable Object without changing it, so its cold
 * start overlaps the dispatch preparation. It is Flue's instance lookup:
 * `null` means Flue holds no agent for the Thread.
 */
type InitialThreadAgentWarmer = (threadId: ThreadId) => Promise<unknown>;

const warmInitialThreadAgent: InitialThreadAgentWarmer = (threadId) =>
  getAgentInstance(DxAgent, threadId);

const resolveCreationResponseDetail = <
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

type AuthorizedProjectSource = NonNullable<
  Awaited<ReturnType<typeof authorizeProjectSource>>
>;

/** The source a new Thread freezes: an exact snapshot, or anonymous intent. */
const threadSourceDraft = (
  projectId: ProjectId,
  authorizedSource: AuthorizedProjectSource,
) =>
  authorizedSource.kind === "anonymous"
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
          providerRepositoryId: authorizedSource.providerRepositoryId,
          authorizationEpoch: authorizedSource.authorizationEpoch,
          installationEpoch: authorizedSource.installationEpoch,
          policyRevision: authorizedSource.policyRevision,
          privateSubmoduleRepositoryIds: [],
        },
      };

/**
 * After a failed first dispatch, removes the Thread this request inserted
 * when Flue holds no agent for it: nothing was admitted, and an empty Thread
 * would otherwise appear in the sidebar. When Flue has the agent, or the
 * lookup fails, the Thread stays because it may hold the message; a same-ID
 * retry then returns its receipt. Succeeds with whether the Thread remains.
 */
const discardUnadmittedThread = (
  db: D1Database,
  thread: Thread,
  lookup: InitialThreadAgentWarmer,
) =>
  Effect.promise(async () => {
    const kept = (event: string, error: unknown) => {
      threadPersistenceLogger.warn("Unadmitted Thread kept.", {
        event,
        threadId: thread.id,
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
      return true;
    };
    let instance: unknown;
    try {
      instance = await lookup(thread.id);
    } catch (error) {
      return kept("thread_creation_instance_lookup_failed", error);
    }
    if (instance !== null) return true;
    try {
      // Files are linked only after admission, so none point at this row.
      await db
        .prepare("DELETE FROM threads WHERE id = ? AND owner_user_id = ?")
        .bind(thread.id, thread.ownerUserId)
        .run();
    } catch (error) {
      return kept("thread_creation_discard_failed", error);
    }
    threadPersistenceLogger.info("Unadmitted Thread removed.", {
      event: "thread_creation_discarded",
      threadId: thread.id,
    });
    return false;
  }).pipe(createPhase("discard"));

/** One `phase` span of `POST /v1/threads`, for the span harness and traces. */
const createPhase = (name: string) =>
  Effect.withSpan(`threads.create.${name}`, {
    attributes: { "dx.kind": "phase" },
  });

export const createThreadRoutes = (
  dispatchInitialMessage: InitialThreadDispatcher = dispatchInitialThreadMessage,
  titleAgent: DxTitleAgentRunner = runDxTitleAgent,
  warmInitialAgent: InitialThreadAgentWarmer = warmInitialThreadAgent,
) => {
  const threadRoutes = new Hono<AppEnv>();

  threadRoutes.post("/", async (context) => {
    const requestId = context.get("requestId");
    const startedAt = Date.now();
    let requestAdmittedAt = startedAt;
    let sourceAuthorizedAt = startedAt;
    let threadPersistedAt = startedAt;
    let agentWarmedAt: number | undefined;
    let detailResolvedAt: number | undefined;
    let initialMessageAdmittedAt: number | undefined;
    // Creation outlives the request: once it reaches Core, a closed tab or a
    // dropped connection cannot stop the Thread or its first message.
    const execution = (() => {
      try {
        return context.executionCtx;
      } catch {
        return undefined;
      }
    })();
    let settleTitlePersisted: ((persisted: boolean) => void) | undefined;
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
      const initialMessage = input.initialMessage;
      // These reads are independent: the first message's files, checked
      // before anything is created so a refused file never leaves an empty
      // Thread behind; the Thread an earlier attempt of this request made;
      // and the author of the first message.
      const [initialAttachments, existingThread, author] = yield* Effect.all(
        [
          initialMessage === undefined
            ? Effect.succeed(undefined)
            : Effect.tryPromise({
                try: () =>
                  resolveMessageAttachments(context.env, {
                    senderUserId: principal.userId,
                    body: initialMessage.body,
                  }),
                catch: (cause) =>
                  cause instanceof MessageAttachmentsRejected
                    ? new InvalidThreadRequest()
                    : new ThreadInitialAdmissionUnavailable(),
              }).pipe(createPhase("attachments")),
          requestedThreadId === undefined
            ? Effect.succeed(undefined)
            : Effect.gen(function* () {
                const service = yield* ThreadService;
                return yield* service
                  .get(principal, requestedThreadId)
                  .pipe(
                    Effect.catchTag("ThreadNotFound", () =>
                      Effect.succeed(undefined),
                    ),
                  );
              }).pipe(Effect.provide(serviceLayer), createPhase("existing")),
          initialMessage === undefined
            ? Effect.succeed(undefined)
            : Effect.tryPromise({
                try: () => userIdentity(db, principal.userId),
                catch: () => new ThreadInitialAdmissionUnavailable(),
              }),
        ] as const,
        { concurrency: "unbounded" },
      );
      // DxTitleAgent needs an execution context to outlive the response.
      const titleExecution = execution;
      // DxTitleAgent starts as soon as creation of a new Thread begins, beside
      // model resolution, persistence, and dispatch. It waits for the row only
      // to store the title; a retry that finds the Thread reuses its title.
      // The title comes from what the person wrote, not the file list.
      const titleMessage = initialAttachments?.text;
      const titlePending =
        existingThread === undefined &&
        requestedThreadId !== undefined &&
        titleExecution !== undefined &&
        titleMessage !== undefined &&
        input.generateTitle !== false &&
        dxTitleAgentApplies(context.env, titleMessage);
      if (titlePending)
        titleExecution.waitUntil(
          titleAgent(context.env, {
            threadId: requestedThreadId,
            ownerUserId: principal.userId,
            selection: input.selection ?? defaultThreadModelSelection(),
            message: titleMessage,
            persisted: new Promise<boolean>((resolve) => {
              settleTitlePersisted = resolve;
            }),
          }),
        );
      // Admission of a runner profile: the requested one, or for a first
      // message the Project's, which the Thread's Orb pin also uses.
      const admitRunnerProfile = (runnerProfileId: RunnerProfileId) =>
        Effect.gen(function* () {
          const catalog = yield* loadRunnerProfileCatalog(context.env);
          const profile = yield* selectRunnerProfile(catalog, runnerProfileId);
          const policy = yield* WorkspacePolicyService;
          yield* policy.evaluateForUser(principal.userId, {
            kind: "execution.admit",
            runnerProfileId: profile.id,
            runnerAdapter: profile.adapter,
          });
          return profile.id;
        });
      // A new Thread passes every gate that can refuse it before its row is
      // written; each gate that does not depend on another runs beside it.
      const target: {
        readonly thread: Thread;
        readonly detail: ThreadDetailData;
        /** What a new Thread writes with its row; absent for a retry. */
        readonly insert?: {
          readonly source?: ReturnType<typeof threadSourceDraft>;
          readonly pin?: ThreadExecutionPin;
        };
      } =
        existingThread !== undefined
          ? {
              thread: existingThread,
              detail: yield* resolveCreationResponseDetail(
                threadDetailData(context.env.DB, db, existingThread),
                // A retry still checks the Thread's runner before dispatch.
                initialMessage === undefined
                  ? undefined
                  : resolveExecutionRunnerProfile(
                      context.env,
                      existingThread.id,
                    ).pipe(
                      Effect.catchTag("ExecutionRunnerProfileUnavailable", () =>
                        Effect.fail(new ThreadInitialAdmissionUnavailable()),
                      ),
                    ),
              ).pipe(createPhase("detail")),
            }
          : yield* Effect.gen(function* () {
              const projectId = input.projectId;
              const requestedRunnerProfileId = input.runnerProfileId;
              const service = yield* ThreadService;
              const modelRoute = Effect.tryPromise({
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
              }).pipe(createPhase("model"));
              const requestedRunner =
                requestedRunnerProfileId === undefined
                  ? Effect.succeed(undefined)
                  : admitRunnerProfile(requestedRunnerProfileId).pipe(
                      createPhase("runner"),
                    );
              const authorizedSource =
                projectId === undefined
                  ? Effect.succeed(undefined)
                  : Effect.tryPromise({
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
                    }).pipe(createPhase("source"));
              const projectSelection =
                projectId === undefined
                  ? Effect.gen(function* () {
                      const membership = yield* Effect.gen(function* () {
                        const repository = yield* WorkspaceRepository;
                        return yield* repository.findByUser(principal.userId);
                      }).pipe(Effect.provide(workspace));
                      const catalog = yield* loadRunnerProfileCatalog(
                        context.env,
                      );
                      const signingCapabilities =
                        yield* signingBackendCapabilities(context.env);
                      const defaults = yield* ProjectDefaultsService;
                      const snapshot = yield* defaults.snapshotForProject(
                        principal,
                        catalog,
                        {
                          ...(Option.isNone(membership)
                            ? {}
                            : {
                                workspaceSlug:
                                  membership.value.workspace.shortName,
                              }),
                          publicCodeEnabled: false,
                          deploymentSigningAvailable: signingCapabilities.some(
                            ({ source, state }) =>
                              source === "deployment" && state === "available",
                          ),
                        },
                      );
                      return { kind: "projectless" as const, snapshot };
                    }).pipe(
                      Effect.provide(projectDefaultsLayersFor(db)),
                      createPhase("project-defaults"),
                    )
                  : Effect.succeed({ kind: "project" as const, projectId });
              const thread = Effect.gen(function* () {
                const project = yield* projectSelection;
                // The Thread pins its Orb (provider, size, and whose key pays)
                // in the same write; the provider set resolves only here.
                const executionPin = Effect.tryPromise({
                  try: () =>
                    resolveThreadExecutionPin({
                      db,
                      bindings: context.env,
                      userId: principal.userId,
                      projectId:
                        project.kind === "project" ? project.projectId : null,
                      runnerProfileId: requestedRunnerProfileId,
                      ...(project.kind === "projectless"
                        ? {
                            projectlessRunnerProfileId:
                              project.snapshot.configuration.runnerProfileId,
                          }
                        : {}),
                      recipe: currentOrbTemplateRecipe,
                    }),
                  catch: (cause) =>
                    cause instanceof OrbUnavailable
                      ? cause
                      : PersistenceUnavailable.new(
                          { operation: "thread.resolveOrb" },
                          cause,
                        ),
                }).pipe(createPhase("orb-pin"));
                const [pin, prepared] = yield* Effect.all(
                  [
                    executionPin,
                    service
                      .prepare(
                        principal,
                        project,
                        input.title ?? UNTITLED_THREAD_TITLE,
                        input.selection,
                        requestedThreadId,
                        requestedRunnerProfileId,
                        titlePending,
                        input.parentThreadId,
                      )
                      .pipe(
                        // Only the parent lookup reports a missing Thread here.
                        Effect.catchTag("ThreadNotFound", () =>
                          Effect.fail(new InvalidThreadRequest()),
                        ),
                        createPhase("prepare"),
                      ),
                  ] as const,
                  { concurrency: "unbounded" },
                );
                // The first message runs on the Project's size when none was
                // requested: admit it now rather than at the Orb's start.
                const projectRunnerProfileId =
                  requestedRunnerProfileId !== undefined ||
                  initialMessage === undefined
                    ? undefined
                    : project.kind === "projectless"
                      ? project.snapshot.configuration.runnerProfileId
                      : prepared.project?.configuration.runnerProfileId;
                const [detail] = yield* Effect.all(
                  [
                    threadDetailData(
                      context.env.DB,
                      db,
                      prepared.thread,
                      true,
                    ).pipe(createPhase("detail")),
                    projectRunnerProfileId === undefined
                      ? Effect.succeed(undefined)
                      : admitRunnerProfile(projectRunnerProfileId).pipe(
                          createPhase("runner"),
                        ),
                  ] as const,
                  { concurrency: "unbounded" },
                );
                return { thread: prepared.thread, pin, detail };
              });
              const [, , source, next] = yield* Effect.all(
                [
                  modelRoute,
                  requestedRunner,
                  authorizedSource,
                  thread,
                ] as const,
                { concurrency: "unbounded" },
              );
              sourceAuthorizedAt = Date.now();
              return {
                thread: next.thread,
                detail: next.detail,
                insert: {
                  pin: next.pin,
                  source:
                    projectId === undefined || source === undefined
                      ? undefined
                      : threadSourceDraft(projectId, source),
                },
              };
            }).pipe(Effect.provide(serviceLayer));
      const detail = target.detail;
      detailResolvedAt = Date.now();
      // Flue checks the same limits at admission; checking here refuses the
      // message before an empty Thread exists.
      if (
        initialMessage !== undefined &&
        !v.is(DxAgentInitialDataSchema, detail.agentInitialization)
      )
        return yield* new InitialMessageRejected();
      // The files are linked to the Thread only once Flue admits the message.
      const admitted =
        initialAttachments === undefined
          ? undefined
          : messageAttachmentBody(
              context.env,
              initialAttachments,
              context.req.url,
            );
      let insertedThread = false;
      const insert = target.insert;
      const thread =
        insert === undefined
          ? target.thread
          : yield* Effect.gen(function* () {
              const service = yield* ThreadService;
              return yield* service
                .insert(target.thread, insert.source, insert.pin)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      insertedThread = true;
                    }),
                  ),
                  Effect.catchTag("PersistenceUnavailable", (failure) =>
                    requestedThreadId === undefined
                      ? Effect.fail(failure)
                      : // A concurrent request created this row; its own
                        // title job owns the title.
                        service
                          .get(principal, requestedThreadId)
                          .pipe(
                            Effect.catchTag("ThreadNotFound", () =>
                              Effect.fail(failure),
                            ),
                          ),
                  ),
                  createPhase("persist"),
                );
            }).pipe(Effect.provide(serviceLayer));
      threadPersistedAt = Date.now();
      // A concurrent attempt inserted the row first: dispatch what it stored.
      const dispatchDetail =
        insert !== undefined && !insertedThread
          ? yield* threadDetailData(context.env.DB, db, thread).pipe(
              createPhase("detail"),
            )
          : detail;
      if (
        initialMessage === undefined ||
        admitted === undefined ||
        author === undefined
      ) {
        settleTitlePersisted?.(insertedThread);
        const body = yield* Schema.encodeUnknownEffect(
          CreateThreadResponseSchema,
        )({ status: "success", data: dispatchDetail });
        return { body, threadId: thread.id };
      }
      // The Thread now exists, so its agent is real: start it while the
      // dispatch is prepared.
      void warmInitialAgent(thread.id).then(
        () => {
          agentWarmedAt = Date.now();
        },
        () => undefined,
      );
      const messageSourceThreadId = context.get("messageSourceThreadId");
      const receipt = yield* Effect.tryPromise({
        try: () =>
          dispatchInitialMessage({
            id: thread.id,
            uid: null,
            initialData: dispatchDetail.agentInitialization,
            message: {
              kind: "user",
              body: withMessageAuthor(
                {
                  author: {
                    role: "owner",
                    userId: thread.ownerUserId,
                    ...author,
                  },
                  // Set only by the in-process Thread tools.
                  ...(messageSourceThreadId === undefined
                    ? {}
                    : { sourceThreadId: messageSourceThreadId }),
                },
                admitted.body,
              ),
              attachments: [...initialMessage.attachments],
            },
            idempotencyKey: "initial",
          }),
        catch: initialDispatchFailure,
      }).pipe(
        createPhase("dispatch"),
        Effect.tapError(() =>
          insertedThread
            ? discardUnadmittedThread(db, thread, warmInitialAgent).pipe(
                Effect.tap((kept) =>
                  Effect.sync(() => settleTitlePersisted?.(kept)),
                ),
              )
            : Effect.void,
        ),
      );
      settleTitlePersisted?.(insertedThread);
      initialMessageAdmittedAt = Date.now();
      if (initialAttachments !== undefined)
        yield* Effect.promise(() =>
          linkMessageAttachments(context.env.DB as D1Database, {
            threadId: thread.id,
            senderUserId: principal.userId,
            rows: initialAttachments.rows,
          }).catch((cause) =>
            threadPersistenceLogger.warn(
              "Message attachments were not recorded.",
              {
                event: "message_attachments_record_failed",
                threadId: thread.id,
                code: cause instanceof Error ? cause.name : "UNKNOWN",
              },
            ),
          ),
        ).pipe(createPhase("attachments-link"));
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
      const body = yield* Schema.encodeUnknownEffect(
        CreateThreadResponseSchema,
      )({
        status: "success",
        data: dispatchDetail,
        initialSubmission: { submissionId: receipt.submissionId },
      });
      return { body, threadId: thread.id };
    });

    const completion = Effect.runPromise(Effect.result(operation)).then(
      async (result) => {
        // A creation that failed before persisting leaves no row to title.
        settleTitlePersisted?.(false);
        if (Result.isSuccess(result))
          await scheduleRealtimeInvalidation(
            () => context.executionCtx,
            context.env,
            result.success.threadId,
            "thread.invalidated",
          );
        return result;
      },
    );
    execution?.waitUntil(completion);
    const result = await completion;
    if (Result.isSuccess(result)) {
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
      // Header-only marks between persistence and the response.
      const responseMarks = [
        ["agent_warmed", agentWarmedAt],
        ["detail_resolved", detailResolvedAt],
        ["initial_message_admitted", initialMessageAdmittedAt],
      ] as const;
      context.header(
        "Server-Timing",
        [
          startupServerTiming(observations),
          ...responseMarks.flatMap(([phase, at]) =>
            at === undefined ? [] : [`dx_${phase};dur=${at - startedAt}`],
          ),
        ].join(", "),
      );
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
        InitialMessageRejected: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadInitialMessageRejectedResponseSchema,
            )({
              status: "error",
              data: {
                code: "INITIAL_MESSAGE_REJECTED",
                message: "The first message could not be accepted.",
                requestId,
              },
            }),
            422,
          ),
        InitialMessageTooLarge: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadInitialMessageTooLargeResponseSchema,
            )({
              status: "error",
              data: {
                code: "INITIAL_MESSAGE_TOO_LARGE",
                message: "The first message is too large.",
                requestId,
              },
            }),
            413,
          ),
        InitialSubmissionConflict: () =>
          context.json(
            Schema.encodeUnknownSync(
              CreateThreadInitialSubmissionConflictResponseSchema,
            )({
              status: "error",
              data: {
                code: "INITIAL_SUBMISSION_CONFLICT",
                message: "This Thread already has a different first message.",
                requestId,
              },
            }),
            409,
          ),
        ThreadAlreadyStarted: () =>
          context.json(
            Schema.encodeUnknownSync(CreateThreadAlreadyStartedResponseSchema)({
              status: "error",
              data: {
                code: "THREAD_ALREADY_STARTED",
                message: "This Thread has already started.",
                requestId,
              },
            }),
            409,
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
        OrbUnavailable: (failure: OrbUnavailable) =>
          context.json(
            Schema.encodeUnknownSync(CreateThreadOrbUnavailableResponseSchema)({
              status: "error",
              data: {
                code: "ORB_UNAVAILABLE",
                message: "The selected Orb is not available.",
                requestId,
                reason: failure.reason,
              },
            }),
            409,
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
      const principal = context.get("principal");
      const page = yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.list(principal, query.projectId, {
          cursor: query.cursor,
          limit: query.limit,
          lifecycleState: query.lifecycleState,
          ...(query.roots !== undefined
            ? { tree: { kind: "roots" as const } }
            : query.parentThreadId !== undefined
              ? {
                  tree: {
                    kind: "children" as const,
                    parentThreadId: query.parentThreadId,
                  },
                }
              : {}),
        });
      }).pipe(Effect.provide(threadServiceLayer(db)));
      const ids = page.items.map(({ id }) => id);
      const decorate = (threadIds: ReadonlyArray<ThreadId>) =>
        Effect.tryPromise({
          try: () =>
            Promise.all([
              readThreadListProjection(db, threadIds),
              threadSharingDecorations(db, threadIds),
            ]),
          catch: (cause) =>
            PersistenceUnavailable.new(
              { operation: "thread.listProjection" },
              cause,
            ),
        });
      // Roots carry the children listed under them, so a parent expands
      // without another request.
      const listChildren = Effect.gen(function* () {
        if (query.roots === undefined) return [];
        const service = yield* ThreadService;
        // A child lists under its parent while both share a lifecycle state.
        const children = yield* Effect.forEach(
          (["active", "archived"] as const).flatMap((lifecycleState) => {
            const parents = page.items.flatMap((thread) =>
              thread.lifecycleState === lifecycleState ? [thread.id] : [],
            );
            return parents.length === 0 ? [] : [{ lifecycleState, parents }];
          }),
          ({ lifecycleState, parents }) =>
            service.listChildren(
              principal,
              parents,
              lifecycleState,
              CHILDREN_PER_ROOT,
            ),
          { concurrency: "unbounded" },
        );
        return children.flat();
      }).pipe(Effect.provide(threadServiceLayer(db)));
      const [children, [projection, sharing], [childCounts, parentColors]] =
        yield* Effect.all(
          [
            listChildren,
            decorate(ids),
            Effect.tryPromise({
              try: () =>
                Promise.all([
                  query.roots === undefined
                    ? new Map<ThreadId, number>()
                    : readThreadChildCounts(db, ids),
                  readParentColors(
                    db,
                    page.items.flatMap(({ parentThreadId }) =>
                      parentThreadId === undefined ? [] : [parentThreadId],
                    ),
                  ),
                ]),
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "thread.listProjection" },
                  cause,
                ),
            }),
          ],
          { concurrency: "unbounded" },
        );
      const [childProjection, childSharing] =
        children.length === 0
          ? [new Map(), new Map()]
          : yield* decorate(children.map(({ id }) => id));
      // A child's parent is a root on this page.
      const rootColors = new Map(
        page.items.flatMap((thread) =>
          thread.color === undefined
            ? []
            : [[thread.id, thread.color] as const],
        ),
      );
      return yield* Schema.encodeUnknownEffect(ListThreadsResponseSchema)({
        status: "success",
        data: {
          items: page.items.map((thread) => ({
            ...threadListItem(thread, projection.get(thread.id)),
            ...sharing.get(thread.id),
            ...(childCounts.has(thread.id)
              ? { childCount: childCounts.get(thread.id) }
              : {}),
            ...parentColorField(parentColors, thread),
          })),
          ...(query.roots === undefined
            ? {}
            : {
                children: children.map((thread) => ({
                  ...threadListItem(thread, childProjection.get(thread.id)),
                  ...childSharing.get(thread.id),
                  ...parentColorField(rootColors, thread),
                })),
              }),
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

  threadRoutes.patch("/:threadId", async (context) => {
    const requestId = context.get("requestId");
    const operation = Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        UpdateThreadParamsSchema,
        { threadId: context.req.param("threadId") },
        () => new InvalidThreadRequest(),
      );
      const body = yield* decodeJsonBody(
        context.req,
        UpdateThreadRequestSchema,
        () => new InvalidThreadRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const thread = yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.update(
          context.get("principal"),
          params.threadId,
          body,
        );
      }).pipe(Effect.provide(threadServiceLayer(db)));
      // Children on auto color show this Thread's color, so a recolor
      // refreshes their detail too.
      const children =
        body.color === undefined
          ? []
          : yield* Effect.tryPromise({
              try: async () =>
                (
                  await db
                    .prepare(
                      `SELECT id FROM threads
                        WHERE parent_thread_id = ? AND owner_user_id = ?
                          AND lifecycle_state != 'deleted' AND color IS NULL`,
                    )
                    .bind(thread.id, thread.ownerUserId)
                    .all<{ id: ThreadId }>()
                ).results,
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "thread.listRecoloredChildren" },
                  cause,
                ),
            });
      for (const { id } of [thread, ...children])
        yield* Effect.promise(() =>
          scheduleRealtimeInvalidation(
            () => context.executionCtx,
            context.env,
            id,
            "thread.invalidated",
          ),
        );
      // A renamed Thread is found by its new title.
      if (body.title !== undefined)
        yield* Effect.promise(async () =>
          scheduleThreadSearchIndex(
            () => context.executionCtx,
            context.env,
            thread.id,
          ),
        );
      return yield* Schema.encodeUnknownEffect(UpdateThreadResponseSchema)({
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
            Schema.encodeUnknownSync(UpdateThreadInvalidRequestResponseSchema)({
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
            Schema.encodeUnknownSync(UpdateThreadNotFoundResponseSchema)({
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
              UpdateThreadPersistenceUnavailableResponseSchema,
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
      const principal = context.get("principal");
      const [thread, children, childFailed] = yield* Effect.gen(function* () {
        const service = yield* ThreadService;
        const parent = yield* service.setArchived(
          principal,
          params.threadId,
          body.archived,
        );
        if (body.includeChildren !== true)
          return [parent, [] as ReadonlyArray<Thread>, false] as const;
        // Every child still in the state the parent just left, page by
        // page; an Undo names exactly the children its archive changed.
        const only =
          body.childThreadIds === undefined
            ? undefined
            : new Set<string>(body.childThreadIds);
        const pending: Thread[] = [];
        let cursor: PageCursor | undefined;
        for (let page = 0; page < 10; page++) {
          const listed = yield* service
            .list(principal, undefined, {
              limit: 100,
              cursor,
              lifecycleState: body.archived ? "active" : "archived",
              tree: { kind: "children", parentThreadId: parent.id },
            })
            .pipe(
              // A cursor from the previous page cannot fail to decode.
              Effect.catchTag("InvalidPageCursor", (cause) =>
                Effect.die(cause),
              ),
            );
          pending.push(
            ...listed.items.filter(
              (child) => only === undefined || only.has(child.id),
            ),
          );
          cursor = listed.nextCursor;
          if (cursor === undefined) break;
        }
        // Each child is best-effort: one deleted meanwhile or a failed
        // write must not keep the others, or the parent, from finishing.
        const results = yield* Effect.forEach(
          pending,
          (child) =>
            service.setArchived(principal, child.id, body.archived).pipe(
              Effect.map((thread) => ({ thread, failed: false })),
              // Deleted since it was listed: nothing left to change.
              Effect.catchTag("ThreadNotFound", () =>
                Effect.succeed({ thread: undefined, failed: false }),
              ),
              Effect.catchTag("PersistenceUnavailable", () =>
                Effect.succeed({ thread: undefined, failed: true }),
              ),
            ),
          { concurrency: 4 },
        );
        const changed = results.flatMap(({ thread }) =>
          thread === undefined ? [] : [thread],
        );
        const failed = results.some((result) => result.failed);
        return [parent, changed, failed] as const;
      }).pipe(Effect.provide(threadServiceLayer(db)));
      for (const changed of [thread, ...children])
        yield* Effect.promise(() =>
          scheduleRealtimeInvalidation(
            () => context.executionCtx,
            context.env,
            changed.id,
            "thread.invalidated",
          ),
        );
      if (body.archived) {
        yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              [thread, ...children].map(({ id }) =>
                ExecutionWorkspaces.archive(id),
              ),
            ),
          catch: () => new ThreadArchiveExecutionUnavailable(),
        });
      }
      // Whatever changed is published and stopped; then a child that could
      // not be written reports the outage.
      if (childFailed)
        return yield* PersistenceUnavailable.new(
          { operation: "thread.archiveChildren" },
          new Error("A child Thread could not be archived or restored."),
        );
      return yield* Schema.encodeUnknownEffect(ArchiveThreadResponseSchema)({
        status: "success",
        data: threadData(thread),
        ...(body.includeChildren === true
          ? { changedChildThreadIds: children.map(({ id }) => id) }
          : {}),
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
      const sharing = yield* Effect.tryPromise({
        try: () =>
          threadSharingDetail(
            db,
            thread.id,
            thread.ownerUserId,
            context.get("threadAccess") ?? "owner",
            (context.get("actor") ?? context.get("principal")).userId as UserId,
          ),
        catch: (cause) =>
          PersistenceUnavailable.new({ operation: "thread.sharing" }, cause),
      });
      return yield* Schema.encodeUnknownEffect(GetThreadResponseSchema)({
        status: "success",
        data: {
          ...(sharing.access === "owner"
            ? detail
            : withoutOwnerConfiguration(detail)),
          ...sharing,
        },
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
