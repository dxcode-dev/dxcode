import {
  CreateProjectForbiddenResponseSchema,
  CreateProjectInvalidRequestResponseSchema,
  CreateProjectNameConflictResponseSchema,
  CreateProjectPersistenceUnavailableResponseSchema,
  CreateProjectPolicyDeniedResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateProjectRunnerUnavailableResponseSchema,
  DeleteProjectInvalidRequestResponseSchema,
  DeleteProjectNameMismatchResponseSchema,
  DeleteProjectNotFoundResponseSchema,
  DeleteProjectParamsSchema,
  DeleteProjectPersistenceUnavailableResponseSchema,
  DeleteProjectRequestSchema,
  DeleteProjectResponseSchema,
  GetProjectInvalidRequestResponseSchema,
  GetProjectNotFoundResponseSchema,
  GetProjectParamsSchema,
  GetProjectPersistenceUnavailableResponseSchema,
  GetProjectResponseSchema,
  ListProjectsInvalidRequestResponseSchema,
  ListProjectsPersistenceUnavailableResponseSchema,
  ListProjectsQuerySchema,
  ListProjectsResponseSchema,
  MoveProjectForbiddenResponseSchema,
  MoveProjectInvalidRequestResponseSchema,
  MoveProjectNameConflictResponseSchema,
  MoveProjectNotFoundResponseSchema,
  MoveProjectParamsSchema,
  MoveProjectPersistenceUnavailableResponseSchema,
  MoveProjectRequestSchema,
  MoveProjectResponseSchema,
  ProjectIconNotImageResponseSchema,
  ProjectIconTooLargeResponseSchema,
  type ProjectViewerAccess,
  RebindProjectSourceForbiddenResponseSchema,
  RebindProjectSourceInvalidRequestResponseSchema,
  RebindProjectSourceNotFoundResponseSchema,
  RebindProjectSourceParamsSchema,
  RebindProjectSourcePersistenceUnavailableResponseSchema,
  RebindProjectSourceRequestSchema,
  RebindProjectSourceResponseSchema,
  SourceControlDeniedResponseSchema,
  SourceControlProviderFailureResponseSchema,
  UpdateProjectInvalidRequestResponseSchema,
  UpdateProjectNameConflictResponseSchema,
  UpdateProjectNotFoundResponseSchema,
  UpdateProjectParamsSchema,
  UpdateProjectPersistenceUnavailableResponseSchema,
  UpdateProjectPolicyDeniedResponseSchema,
  UpdateProjectRequestSchema,
  UpdateProjectResponseSchema,
  UpdateProjectRunnerUnavailableResponseSchema,
} from "@dx/api";
import {
  type CanonicalGitRemoteAlias,
  canonicalBitbucketRepositoryLocator,
  canonicalGitHubRepositoryLocator,
  canonicalGitRemoteAlias,
  canonicalPublicGitRepositoryLocator,
  PersistenceUnavailable,
  PersonalAccountRepository,
  PROJECTLESS_PROJECT_NAME,
  type Project,
  type ProjectAdditionalRepository,
  ProjectNotFound,
  projectAdditionalRepositoryFromUrl,
  SourceControlAccessDenied,
  SourceControlProviderFailure,
  type UserId,
  type WorkspacePolicyDenied,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Match, Option, Result, Schema } from "effect";
import { Hono } from "hono";
import { sniffAttachmentType } from "../attachments/store.js";
import { ExecutionWorkspaces } from "../execution/execution-workspaces.js";
import {
  loadRunnerProfileCatalog,
  selectRunnerProfile,
} from "../execution/runner-profiles/catalog.js";
import { feedbackWidgetSettingsRoutes } from "../feedback-widget/settings-routes.js";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../http/request-decoding.js";
import type { AppEnv } from "../http/types.js";
import { projectPersistenceLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import { PersonalAccountRepositoryD1 } from "../settings/account/repository-d1.js";
import { SettingsAudit } from "../settings/audit.js";
import { refreshActiveThreadEnvironments } from "../settings/environment-variables/refresh.js";
import { signingBackendCapabilities } from "../settings/keys/backend.js";
import { projectDefaultsLayersFor } from "../settings/project-defaults/routes.js";
import { ProjectDefaultsService } from "../settings/project-defaults/service.js";
import { SettingsService } from "../settings/service.js";
import { WorkspaceRepositoryD1 } from "../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../settings/workspace-policy/service.js";
import { authorizeSource } from "../source-control/admission.js";
import { purgeDeletedThread } from "../thread-deletion/cleanup.js";
import { deployedThreadCleanup } from "../thread-deletion/routes.js";
import { projectViewerAccess } from "./access.js";
import {
  deleteProject,
  type ProjectDeletion,
  ProjectDeletionNameMismatch,
  ProjectDeletionNotFound,
} from "./deletion.js";
import {
  moveProject,
  type ProjectMove,
  ProjectMoveNameConflict,
  ProjectMoveNotFound,
} from "./move.js";
import { projectOrbScriptRoutes } from "./orb-scripts.js";
import { ProjectRepositoryD1 } from "./repository-d1.js";
import { ProjectService } from "./service.js";

class InvalidProjectRequest extends Schema.TaggedError<InvalidProjectRequest>()(
  "InvalidProjectRequest",
  {},
) {}

class ProjectIconNotImage extends Schema.TaggedError<ProjectIconNotImage>()(
  "ProjectIconNotImage",
  {},
) {}

class ProjectIconTooLarge extends Schema.TaggedError<ProjectIconTooLarge>()(
  "ProjectIconTooLarge",
  {},
) {}

class ProjectIconNotFound extends Schema.TaggedError<ProjectIconNotFound>()(
  "ProjectIconNotFound",
  {},
) {}

class ProjectSourceRebindForbidden extends Schema.TaggedError<ProjectSourceRebindForbidden>()(
  "ProjectSourceRebindForbidden",
  {},
) {}

const projectData = (project: Project) => ({
  id: project.id,
  name: project.name,
  ...(project.description === undefined
    ? {}
    : { description: project.description }),
  ...(project.iconKey === undefined
    ? {}
    : {
        iconUrl: `/v1/projects/${encodeURIComponent(project.id)}/icon?v=${project.revision}`,
      }),
  ...(project.repository === undefined
    ? {}
    : { repository: project.repository }),
  additionalRepositories: project.additionalRepositories,
  remoteAliases: project.remoteAliases,
  revision: project.revision,
  ...(project.workspaceId === undefined
    ? {}
    : { workspaceId: project.workspaceId }),
  configuration: project.configuration,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const withViewerAccess = (
  data: ReturnType<typeof projectData>,
  viewerAccess: ProjectViewerAccess | undefined,
) => (viewerAccess === undefined ? data : { ...data, viewerAccess });

/**
 * Canonical additional repositories in request order, without duplicates or
 * the primary repository. Request validation already proved each URL.
 */
const additionalRepositoriesFrom = (
  urls: ReadonlyArray<string> | undefined,
  primaryCloneUrl: string | undefined,
): Array<ProjectAdditionalRepository> => {
  const seen = new Set(
    primaryCloneUrl === undefined ? [] : [primaryCloneUrl.toLowerCase()],
  );
  return (urls ?? []).flatMap((url) => {
    const repository = projectAdditionalRepositoryFromUrl(url);
    if (repository === undefined) throw new InvalidProjectRequest();
    const key = repository.cloneUrl.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [repository];
  });
};

/**
 * Canonical remote aliases in request order, without duplicates or the
 * primary repository's own HTTPS URL. Request validation proved each one.
 */
const remoteAliasesFrom = (
  urls: ReadonlyArray<string>,
  primaryWebUrl: string | undefined,
): Array<CanonicalGitRemoteAlias> => {
  const seen = new Set(
    primaryWebUrl === undefined ? [] : [primaryWebUrl.toLowerCase()],
  );
  return urls.flatMap((url) => {
    const alias = canonicalGitRemoteAlias(url);
    if (alias === undefined) throw new InvalidProjectRequest();
    const key = alias.url.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [alias];
  });
};

export const projectRoutes = new Hono<AppEnv>();

const workspacePolicyLayerFor = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  return WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
};

const bodyTooLarge = new Error("Request body exceeds the size limit.");

const readLimitedRequestBody = Effect.fn("readLimitedRequestBody")(function* (
  request: Request,
  maxBytes: number,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw bodyTooLarge;
      }
      const reader = request.body?.getReader();
      if (reader === undefined) return new Uint8Array();
      const chunks: Array<Uint8Array> = [];
      let length = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw bodyTooLarge;
        }
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
    catch: (cause) =>
      cause === bodyTooLarge
        ? new ProjectIconTooLarge()
        : new InvalidProjectRequest(),
  });
});

projectRoutes.post("/", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const input = yield* decodeJsonBody(
      context.req,
      CreateProjectRequestSchema,
      () => new InvalidProjectRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = ProjectRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const catalog = yield* loadRunnerProfileCatalog(context.env);
    const signingCapabilities = yield* signingBackendCapabilities(context.env);
    const snapshot = yield* Effect.gen(function* () {
      const defaults = yield* ProjectDefaultsService;
      return yield* defaults.snapshotForProject(
        context.get("principal"),
        catalog,
        {
          ...(input.workspaceSlug === undefined
            ? {}
            : { workspaceSlug: input.workspaceSlug }),
          publicCodeEnabled: input.publicCodeEnabled ?? false,
          deploymentSigningAvailable: signingCapabilities.some(
            ({ source, state }) =>
              source === "deployment" && state === "available",
          ),
        },
      );
    }).pipe(Effect.provide(projectDefaultsLayersFor(db)));
    const source = input.source;
    const sourceBinding =
      source?.kind === "public-git-url"
        ? (() => {
            const locator = canonicalPublicGitRepositoryLocator(source.url);
            if (locator === undefined) throw new InvalidProjectRequest();
            return {
              repository: {
                provider: "git" as const,
                bindingRevision: 1,
                ...locator,
              },
            };
          })()
        : source?.kind === "github-url" || source?.kind === "bitbucket-url"
          ? (() => {
              const provider =
                source.kind === "github-url"
                  ? ("github" as const)
                  : ("bitbucket" as const);
              const locator =
                provider === "github"
                  ? canonicalGitHubRepositoryLocator(source.url)
                  : canonicalBitbucketRepositoryLocator(source.url);
              if (locator === undefined) throw new InvalidProjectRequest();
              return {
                repository: {
                  provider,
                  bindingRevision: 1,
                  ...locator,
                },
              };
            })()
          : source?.kind !== "repository"
            ? undefined
            : yield* Effect.tryPromise({
                try: () =>
                  authorizeSource({
                    db,
                    bindings: context.env,
                    // Workspace and private Projects bind a repository the
                    // creator reaches through their own personal grant.
                    owner: {
                      scope: "personal",
                      id: context.get("principal").userId,
                    },
                    grantId: source.grantId,
                    repositoryId: source.providerRepositoryId,
                    provider: source.provider ?? "github",
                    ...(source.workspaceId === undefined
                      ? {}
                      : { workspaceId: source.workspaceId }),
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
              }).pipe(
                Effect.map((authorized) => ({
                  repository: {
                    provider: authorized.provider,
                    bindingRevision: 1,
                    fullName: authorized.fullName,
                    webUrl: authorized.webUrl,
                    cloneUrl: authorized.cloneUrl,
                  },
                  sourceAuthority: {
                    provider: authorized.provider,
                    ownerScope: authorized.owner.scope,
                    ownerId: authorized.owner.id,
                    grantId: authorized.grantId,
                    installationId: authorized.installationId,
                    providerWorkspaceId: authorized.providerWorkspaceId,
                    providerRepositoryId: authorized.providerRepositoryId,
                    bindingRevision: 1,
                    provenance: "live-grant" as const,
                    defaultBranch: authorized.defaultBranch,
                    health: { state: "available" as const },
                    authorizationEpoch: authorized.authorizationEpoch,
                    installationEpoch: authorized.installationEpoch,
                    policyRevision: authorized.policyRevision,
                  },
                })),
              );
    const project = yield* Effect.gen(function* () {
      const service = yield* ProjectService;
      return yield* service.create(
        context.get("principal"),
        input.name,
        snapshot,
        {
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...sourceBinding,
          additionalRepositories: additionalRepositoriesFrom(
            input.additionalRepositories,
            sourceBinding?.repository.cloneUrl,
          ),
        },
      );
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    return yield* Schema.encodeUnknownEffect(CreateProjectResponseSchema)({
      status: "success",
      data: projectData(project),
    });
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 201);

  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidProjectRequest: () =>
        context.json(
          Schema.encodeUnknownSync(CreateProjectInvalidRequestResponseSchema)({
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
            CreateProjectPersistenceUnavailableResponseSchema,
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
      ProjectNameConflict: () =>
        context.json(
          Schema.encodeUnknownSync(CreateProjectNameConflictResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NAME_CONFLICT",
              message: "A project with this name already exists.",
              requestId,
            },
          }),
          409,
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
          Schema.encodeUnknownSync(SourceControlProviderFailureResponseSchema)({
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
      ProjectPolicyForbidden: () =>
        context.json(
          Schema.encodeUnknownSync(CreateProjectForbiddenResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_CREATION_FORBIDDEN",
              message: "Workspace policy does not allow this project.",
              requestId,
            },
          }),
          403,
        ),
      WorkspacePolicyDenied: (denial: WorkspacePolicyDenied) =>
        context.json(
          Schema.encodeUnknownSync(CreateProjectPolicyDeniedResponseSchema)({
            status: "error",
            data: {
              code: "WORKSPACE_POLICY_DENIED",
              message: "Workspace policy does not allow this project.",
              requestId,
              reason: denial.reason,
            },
          }),
          403,
        ),
      SettingsScopeForbidden: () =>
        context.json(
          Schema.encodeUnknownSync(CreateProjectForbiddenResponseSchema)({
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
            CreateProjectRunnerUnavailableResponseSchema,
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
            CreateProjectPersistenceUnavailableResponseSchema,
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
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      PersonalAccountNotFound: (error) => {
        throw error;
      },
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

projectRoutes.get("/", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const query = yield* decodeRequestInput(
      ListProjectsQuerySchema,
      context.req.query(),
      () => new InvalidProjectRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = ProjectRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const page = yield* Effect.gen(function* () {
      const service = yield* ProjectService;
      return yield* service.list(context.get("principal"), {
        cursor: query.cursor,
        limit: query.limit,
      });
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    const access = yield* Effect.promise(() =>
      projectViewerAccess(
        db,
        context.get("principal").userId,
        page.items.map((project) => project.id),
      ),
    );
    return yield* Schema.encodeUnknownEffect(ListProjectsResponseSchema)({
      status: "success",
      data: {
        items: page.items.map((project) =>
          withViewerAccess(projectData(project), access.get(project.id)),
        ),
        nextCursor: page.nextCursor,
      },
    });
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);

  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidProjectRequest: () =>
        context.json(
          Schema.encodeUnknownSync(ListProjectsInvalidRequestResponseSchema)({
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
          Schema.encodeUnknownSync(ListProjectsInvalidRequestResponseSchema)({
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
            ListProjectsPersistenceUnavailableResponseSchema,
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

projectRoutes.get("/:projectId", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const params = yield* decodeRequestInput(
      GetProjectParamsSchema,
      { projectId: context.req.param("projectId") },
      () => new InvalidProjectRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = ProjectRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const project = yield* Effect.gen(function* () {
      const service = yield* ProjectService;
      return yield* service.get(context.get("principal"), params.projectId);
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    const access = yield* Effect.promise(() =>
      projectViewerAccess(db, context.get("principal").userId, [project.id]),
    );
    return yield* Schema.encodeUnknownEffect(GetProjectResponseSchema)({
      status: "success",
      data: withViewerAccess(projectData(project), access.get(project.id)),
    });
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);

  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidProjectRequest: () =>
        context.json(
          Schema.encodeUnknownSync(GetProjectInvalidRequestResponseSchema)({
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
          Schema.encodeUnknownSync(GetProjectNotFoundResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NOT_FOUND",
              message: "Project not found.",
              requestId,
            },
          }),
          404,
        ),
      PersistenceUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            GetProjectPersistenceUnavailableResponseSchema,
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

projectRoutes.put("/:projectId/source", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const params = yield* decodeRequestInput(
      RebindProjectSourceParamsSchema,
      { projectId: context.req.param("projectId") },
      () => new InvalidProjectRequest(),
    );
    const input = yield* decodeJsonBody(
      context.req,
      RebindProjectSourceRequestSchema,
      () => new InvalidProjectRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = ProjectRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const current = yield* Effect.gen(function* () {
      return yield* (yield* ProjectService).get(
        context.get("principal"),
        params.projectId,
      );
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    // The rebinding user's personal grant authorizes the repository for both
    // private and workspace Projects.
    const owner = {
      scope: "personal" as const,
      id: context.get("principal").userId,
    };
    if (current.workspaceId !== undefined) {
      const membership = yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(
              `SELECT member.role, organization.lifecycleState AS lifecycle_state
                 FROM member
                 JOIN organization ON organization.id = member.organizationId
                WHERE member.organizationId = ? AND member.userId = ?`,
            )
            .bind(current.workspaceId, context.get("principal").userId)
            .first<{ role: string; lifecycle_state: string }>(),
        catch: () => new ProjectSourceRebindForbidden(),
      });
      if (membership === null || membership.lifecycle_state !== "active")
        return yield* new ProjectSourceRebindForbidden();
    }
    const bindingRevision = (current.repository?.bindingRevision ?? 0) + 1;
    if ("url" in input) {
      // Cloned as is, like a Project created from a URL. Existing Threads
      // keep the source they snapshotted; new ones clone this URL.
      const locator = canonicalPublicGitRepositoryLocator(input.url);
      if (locator === undefined) return yield* new InvalidProjectRequest();
      const project = yield* Effect.gen(function* () {
        return yield* (yield* ProjectService).rebindRepository(
          context.get("principal"),
          params.projectId,
          input.revision,
          { provider: "git", bindingRevision, ...locator },
        );
      }).pipe(
        Effect.provide(
          ProjectService.layer.pipe(Layer.provide(repositoryLayer)),
        ),
      );
      return yield* Schema.encodeUnknownEffect(
        RebindProjectSourceResponseSchema,
      )({ status: "success", data: projectData(project) });
    }
    const authorized = yield* Effect.tryPromise({
      try: () =>
        authorizeSource({
          db,
          bindings: context.env,
          owner,
          grantId: input.grantId,
          repositoryId: input.providerRepositoryId,
          provider: input.provider ?? "github",
          ...(input.workspaceId === undefined
            ? {}
            : { workspaceId: input.workspaceId }),
          waitUntil: (promise) => context.executionCtx.waitUntil(promise),
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
    const project = yield* Effect.gen(function* () {
      return yield* (yield* ProjectService).rebindRepository(
        context.get("principal"),
        params.projectId,
        input.revision,
        {
          provider: authorized.provider,
          bindingRevision,
          fullName: authorized.fullName,
          webUrl: authorized.webUrl,
          cloneUrl: authorized.cloneUrl,
        },
        {
          provider: authorized.provider,
          ownerScope: authorized.owner.scope,
          ownerId: authorized.owner.id,
          grantId: authorized.grantId,
          installationId: authorized.installationId,
          providerWorkspaceId: authorized.providerWorkspaceId,
          providerRepositoryId: authorized.providerRepositoryId,
          bindingRevision,
          provenance: "live-grant",
          defaultBranch: authorized.defaultBranch,
          health: { state: "available" },
          authorizationEpoch: authorized.authorizationEpoch,
          installationEpoch: authorized.installationEpoch,
          policyRevision: authorized.policyRevision,
        },
      );
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    return yield* Schema.encodeUnknownEffect(RebindProjectSourceResponseSchema)(
      { status: "success", data: projectData(project) },
    );
  });
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidProjectRequest: () =>
        context.json(
          Schema.encodeUnknownSync(
            RebindProjectSourceInvalidRequestResponseSchema,
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
      ProjectNotFound: () =>
        context.json(
          Schema.encodeUnknownSync(RebindProjectSourceNotFoundResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NOT_FOUND",
              message: "Project not found.",
              requestId,
            },
          }),
          404,
        ),
      ProjectSourceRebindForbidden: () =>
        context.json(
          Schema.encodeUnknownSync(RebindProjectSourceForbiddenResponseSchema)({
            status: "error",
            data: {
              code: "FORBIDDEN",
              message: "You cannot rebind this Project source.",
              requestId,
            },
          }),
          403,
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
          Schema.encodeUnknownSync(SourceControlProviderFailureResponseSchema)({
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
      PersistenceUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            RebindProjectSourcePersistenceUnavailableResponseSchema,
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

projectRoutes.patch("/:projectId", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const params = yield* decodeRequestInput(
      UpdateProjectParamsSchema,
      { projectId: context.req.param("projectId") },
      () => new InvalidProjectRequest(),
    );
    const input = yield* decodeJsonBody(
      context.req,
      UpdateProjectRequestSchema,
      () => new InvalidProjectRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = ProjectRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const project = yield* Effect.gen(function* () {
      const service = yield* ProjectService;
      const current = yield* service.get(
        context.get("principal"),
        params.projectId,
      );
      let configuration = current.configuration;
      if (input.runnerProfileId !== undefined) {
        const catalog = yield* loadRunnerProfileCatalog(context.env);
        const profile = yield* selectRunnerProfile(
          catalog,
          input.runnerProfileId,
        );
        if (current.workspaceId !== undefined) {
          yield* Effect.gen(function* () {
            const policy = yield* WorkspacePolicyService;
            yield* policy.evaluateForUser(context.get("principal").userId, {
              kind: "project.create",
              runnerProfileId: profile.id,
              runnerAdapter: profile.adapter,
            });
          }).pipe(Effect.provide(workspacePolicyLayerFor(db)));
        }
        configuration = {
          ...configuration,
          runnerProfileId: input.runnerProfileId,
        };
      }
      // Custom Ship sends the prompt sent with it or the one already saved;
      // another behavior keeps the saved prompt for the next Custom Ship.
      const shipPrompt = input.shipPrompt ?? configuration.shipPrompt;
      const shipAction = input.shipAction ?? configuration.shipAction;
      if (shipAction === "custom" && shipPrompt === undefined)
        return yield* new InvalidProjectRequest();
      configuration = {
        ...configuration,
        shipAction,
        ...(shipPrompt === undefined ? {} : { shipPrompt }),
        ...(input.dxCoAuthor === undefined
          ? {}
          : { dxCoAuthor: input.dxCoAuthor }),
      };
      // The person who authors commits is the project's owner, as when the
      // project was created; another member's Thread uses that member.
      if (
        input.commitAuthor !== undefined &&
        input.commitAuthor !== configuration.commitAuthor.preference
      ) {
        const commitAuthor =
          input.commitAuthor === "dx"
            ? {
                preference: "dx" as const,
                name: "dxcodeagent",
                email: "agent@dxcode.dev",
              }
            : yield* Effect.gen(function* () {
                const accounts = yield* PersonalAccountRepository;
                const account = yield* accounts.findOwnedByUser(
                  current.ownerUserId,
                );
                return {
                  preference: "user" as const,
                  name: account.displayName,
                  email: account.email,
                };
              }).pipe(
                Effect.provide(
                  PersonalAccountRepositoryD1.pipe(
                    Layer.provide(D1Client.layer({ db })),
                  ),
                ),
              );
        configuration = { ...configuration, commitAuthor };
      }
      return yield* service.update(
        context.get("principal"),
        params.projectId,
        input.revision,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined
            ? {}
            : { description: input.description || undefined }),
          ...(input.additionalRepositories === undefined
            ? {}
            : {
                additionalRepositories: additionalRepositoriesFrom(
                  input.additionalRepositories,
                  current.repository?.cloneUrl,
                ),
              }),
          ...(input.remoteAliases === undefined
            ? {}
            : {
                remoteAliases: remoteAliasesFrom(
                  input.remoteAliases,
                  current.repository?.webUrl,
                ),
              }),
          configuration,
        },
      );
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    // Running Orbs take a new commit identity now, not at their next wake.
    if (
      (input.commitAuthor !== undefined || input.dxCoAuthor !== undefined) &&
      context.env.THREAD_EXECUTION !== undefined
    )
      context.executionCtx.waitUntil(
        refreshActiveThreadEnvironments(context.env, db, {
          scope: "project",
          id: project.id,
        }).catch(() => undefined),
      );
    return yield* Schema.encodeUnknownEffect(UpdateProjectResponseSchema)({
      status: "success",
      data: projectData(project),
    });
  });
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidProjectRequest: () =>
        context.json(
          Schema.encodeUnknownSync(UpdateProjectInvalidRequestResponseSchema)({
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
          Schema.encodeUnknownSync(UpdateProjectNotFoundResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NOT_FOUND",
              message: "Project not found.",
              requestId,
            },
          }),
          404,
        ),
      ProjectNameConflict: () =>
        context.json(
          Schema.encodeUnknownSync(UpdateProjectNameConflictResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NAME_CONFLICT",
              message: "A project with this name already exists.",
              requestId,
            },
          }),
          409,
        ),
      PersistenceUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            UpdateProjectPersistenceUnavailableResponseSchema,
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
      RunnerProfileUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            UpdateProjectRunnerUnavailableResponseSchema,
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
      WorkspacePolicyDenied: (denial: WorkspacePolicyDenied) =>
        context.json(
          Schema.encodeUnknownSync(UpdateProjectPolicyDeniedResponseSchema)({
            status: "error",
            data: {
              code: "WORKSPACE_POLICY_DENIED",
              message: "Workspace policy does not allow this runner profile.",
              requestId,
              reason: denial.reason,
            },
          }),
          403,
        ),
      // Every user has a personal account; a missing one is a store fault.
      PersonalAccountNotFound: () =>
        context.json(
          Schema.encodeUnknownSync(
            UpdateProjectPersistenceUnavailableResponseSchema,
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
      SettingsMembershipInvariantViolation: () =>
        context.json(
          Schema.encodeUnknownSync(
            UpdateProjectPersistenceUnavailableResponseSchema,
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
      RunnerProfileConfigurationUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            UpdateProjectPersistenceUnavailableResponseSchema,
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

projectRoutes.get("/:projectId/icon", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const { projectId } = yield* decodeRequestInput(
      UpdateProjectParamsSchema,
      { projectId: context.req.param("projectId") },
      () => new InvalidProjectRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = ProjectRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const project = yield* Effect.gen(function* () {
      const service = yield* ProjectService;
      return yield* service.get(context.get("principal"), projectId);
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    if (project.iconKey === undefined) return yield* new ProjectIconNotFound();
    const storage = context.env.DX_STORAGE;
    if (storage === undefined) {
      return yield* PersistenceUnavailable.new(
        { operation: "project.icon.get" },
        new Error("DX_STORAGE binding is unavailable."),
      );
    }
    const object = yield* Effect.tryPromise({
      try: () => storage.get(project.iconKey as string),
      catch: (cause) =>
        PersistenceUnavailable.new({ operation: "project.icon.get" }, cause),
    });
    return object ?? (yield* new ProjectIconNotFound());
  });
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) {
    return new Response(result.success.body, {
      headers: {
        "content-type": result.success.httpMetadata?.contentType ?? "image/png",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
        etag: result.success.httpEtag,
      },
    });
  }
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidProjectRequest: () =>
        context.json(
          Schema.encodeUnknownSync(GetProjectInvalidRequestResponseSchema)({
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
          Schema.encodeUnknownSync(GetProjectNotFoundResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NOT_FOUND",
              message: "Project not found.",
              requestId,
            },
          }),
          404,
        ),
      ProjectIconNotFound: () =>
        context.json(
          Schema.encodeUnknownSync(GetProjectNotFoundResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NOT_FOUND",
              message: "Project not found.",
              requestId,
            },
          }),
          404,
        ),
      PersistenceUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            GetProjectPersistenceUnavailableResponseSchema,
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

const iconExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

projectRoutes.put("/:projectId/icon", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const { projectId } = yield* decodeRequestInput(
      UpdateProjectParamsSchema,
      { projectId: context.req.param("projectId") },
      () => new InvalidProjectRequest(),
    );
    const revision = Number(context.req.header("x-project-revision"));
    if (!Number.isInteger(revision)) return yield* new InvalidProjectRequest();
    const bytes = yield* readLimitedRequestBody(context.req.raw, 512 * 1024);
    // The browser names the type from the file extension; only the bytes
    // prove an image.
    const contentType = sniffAttachmentType(bytes) ?? "";
    const extension = iconExtensions.get(contentType);
    if (extension === undefined) return yield* new ProjectIconNotImage();
    const storage = context.env.DX_STORAGE;
    if (storage === undefined) {
      return yield* PersistenceUnavailable.new(
        { operation: "project.icon.put" },
        new Error("DX_STORAGE binding is unavailable."),
      );
    }
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = ProjectRepositoryD1.pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const iconKey = `projects/${projectId}/${crypto.randomUUID()}.${extension}`;
    const project = yield* Effect.gen(function* () {
      const service = yield* ProjectService;
      const current = yield* service.get(context.get("principal"), projectId);
      yield* Effect.tryPromise({
        try: () =>
          storage.put(iconKey, bytes, { httpMetadata: { contentType } }),
        catch: (cause) =>
          PersistenceUnavailable.new({ operation: "project.icon.put" }, cause),
      });
      return yield* service
        .update(context.get("principal"), projectId, revision, { iconKey })
        .pipe(
          Effect.onError(() =>
            Effect.tryPromise({
              try: () => storage.delete(iconKey),
              catch: () => undefined,
            }).pipe(Effect.ignore),
          ),
          Effect.tap(() =>
            current.iconKey === undefined
              ? Effect.void
              : Effect.tryPromise({
                  try: () => storage.delete(current.iconKey as string),
                  catch: () => undefined,
                }).pipe(Effect.ignore),
          ),
        );
    }).pipe(
      Effect.provide(ProjectService.layer.pipe(Layer.provide(repositoryLayer))),
    );
    return yield* Schema.encodeUnknownEffect(UpdateProjectResponseSchema)({
      status: "success",
      data: projectData(project),
    });
  });
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidProjectRequest: () =>
        context.json(
          Schema.encodeUnknownSync(UpdateProjectInvalidRequestResponseSchema)({
            status: "error",
            data: {
              code: "INVALID_REQUEST",
              message: "Request validation failed.",
              requestId,
            },
          }),
          400,
        ),
      ProjectIconNotImage: () =>
        context.json(
          Schema.encodeUnknownSync(ProjectIconNotImageResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_ICON_NOT_IMAGE",
              message: "Choose a PNG, JPEG, or WebP image.",
              requestId,
            },
          }),
          415,
        ),
      ProjectIconTooLarge: () =>
        context.json(
          Schema.encodeUnknownSync(ProjectIconTooLargeResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_ICON_TOO_LARGE",
              message: "Choose an image of 512 KB or less.",
              requestId,
            },
          }),
          413,
        ),
      ProjectNotFound: () =>
        context.json(
          Schema.encodeUnknownSync(UpdateProjectNotFoundResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NOT_FOUND",
              message: "Project not found.",
              requestId,
            },
          }),
          404,
        ),
      ProjectNameConflict: () =>
        context.json(
          Schema.encodeUnknownSync(UpdateProjectNameConflictResponseSchema)({
            status: "error",
            data: {
              code: "PROJECT_NAME_CONFLICT",
              message: "A project with this name already exists.",
              requestId,
            },
          }),
          409,
        ),
      PersistenceUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            UpdateProjectPersistenceUnavailableResponseSchema,
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

projectRoutes.route("/", projectOrbScriptRoutes);
projectRoutes.route("/", feedbackWidgetSettingsRoutes);

/**
 * `POST /v1/projects/:projectId/move` (Change Owner, #1198): the creator of
 * a personal project moves it into their workspace, for good. The move
 * follows the rules for creating a project there: the person must be
 * allowed to create one and the name must be free. The project keeps its
 * Orb size when the workspace allows it, else takes the workspace default,
 * and loses public code access the workspace forbids. After the response,
 * Orbs running on the owner's personal Orb keys stop when the workspace
 * does not allow them, and open apps refresh the project's Threads.
 */
projectRoutes.post("/:projectId/move", async (context) => {
  const requestId = context.get("requestId");
  const principal = context.get("principal");
  const failure = (
    schema:
      | typeof MoveProjectInvalidRequestResponseSchema
      | typeof MoveProjectNotFoundResponseSchema
      | typeof MoveProjectNameConflictResponseSchema
      | typeof MoveProjectForbiddenResponseSchema
      | typeof MoveProjectPersistenceUnavailableResponseSchema,
    status: 400 | 403 | 404 | 409 | 503,
  ) => {
    const [code, message] = {
      400: ["INVALID_REQUEST", "Request validation failed."],
      403: [
        "PROJECT_MOVE_FORBIDDEN",
        "You cannot move projects into this workspace.",
      ],
      404: ["PROJECT_NOT_FOUND", "Project not found."],
      409: [
        "PROJECT_NAME_CONFLICT",
        "A project with this name already exists.",
      ],
      503: [
        "PERSISTENCE_UNAVAILABLE",
        "Persistence is temporarily unavailable.",
      ],
    }[status];
    return context.json(
      Schema.encodeUnknownSync(schema)({
        status: "error",
        data: { code, message, requestId },
      } as never),
      status,
    );
  };
  const notFound = () => failure(MoveProjectNotFoundResponseSchema, 404);
  const forbidden = () => failure(MoveProjectForbiddenResponseSchema, 403);
  const unavailable = () =>
    failure(MoveProjectPersistenceUnavailableResponseSchema, 503);
  const params = Schema.decodeUnknownOption(MoveProjectParamsSchema)({
    projectId: context.req.param("projectId"),
  });
  const body = Schema.decodeUnknownOption(MoveProjectRequestSchema)(
    await context.req.json().catch(() => undefined),
  );
  if (Option.isNone(params) || Option.isNone(body))
    return failure(MoveProjectInvalidRequestResponseSchema, 400);
  const db = context.env.DB;
  if (db === undefined) return unavailable();
  const projectId = params.value.projectId;
  const repositoryLayer = ProjectRepositoryD1.pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const projectService = ProjectService.layer.pipe(
    Layer.provide(repositoryLayer),
  );

  const prepared = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const current = yield* Effect.gen(function* () {
          return yield* (yield* ProjectService).get(principal, projectId);
        }).pipe(Effect.provide(projectService));
        if (
          current.workspaceId !== undefined ||
          current.ownerUserId !== principal.userId ||
          current.name === PROJECTLESS_PROJECT_NAME
        )
          return yield* new ProjectNotFound({ projectId });
        const catalog = yield* loadRunnerProfileCatalog(context.env);
        const signingCapabilities = yield* signingBackendCapabilities(
          context.env,
        );
        const { workspace, snapshot } = yield* Effect.gen(function* () {
          const defaults = yield* ProjectDefaultsService;
          const workspace = yield* defaults.getWorkspace(
            principal,
            body.value.workspaceSlug,
            catalog,
          );
          // Creating a project there must be allowed; this also yields the
          // workspace's default Orb size.
          const snapshot = yield* defaults.snapshotForProject(
            principal,
            catalog,
            {
              workspaceSlug: body.value.workspaceSlug,
              publicCodeEnabled: false,
              deploymentSigningAvailable: signingCapabilities.some(
                ({ source, state }) =>
                  source === "deployment" && state === "available",
              ),
            },
          );
          return { workspace, snapshot };
        }).pipe(Effect.provide(projectDefaultsLayersFor(db)));
        const currentSize = current.configuration.runnerProfileId;
        const allowed = workspace.restrictions.allowedRunnerProfileIds;
        const profile = yield* selectRunnerProfile(catalog, currentSize).pipe(
          Effect.option,
        );
        const keepsSize =
          Option.isSome(profile) &&
          (allowed === null || allowed.includes(profile.value.id)) &&
          (yield* Effect.gen(function* () {
            const policy = yield* WorkspacePolicyService;
            return yield* policy
              .evaluateForUser(principal.userId, {
                kind: "project.create",
                runnerProfileId: profile.value.id,
                runnerAdapter: profile.value.adapter,
              })
              .pipe(
                Effect.as(true),
                Effect.catchTag("WorkspacePolicyDenied", () =>
                  Effect.succeed(false),
                ),
              );
          }).pipe(Effect.provide(workspacePolicyLayerFor(db))));
        return {
          workspaceId: workspace.settings.workspaceId,
          runnerProfileId: keepsSize
            ? currentSize
            : snapshot.configuration.runnerProfileId,
          publicCodeEnabled:
            current.configuration.publicCodeEnabled &&
            workspace.restrictions.allowPublicCodeAccess,
        };
      }),
    ),
  );
  if (Result.isFailure(prepared)) {
    const notReady = (reason: string) => {
      projectPersistenceLogger.warn("Project move could not be prepared.", {
        event: "project_move_prepare_failed",
        requestId,
        projectId,
        reason,
      });
      return unavailable();
    };
    return Match.value(prepared.failure).pipe(
      Match.tags({
        ProjectNotFound: notFound,
        SettingsScopeForbidden: forbidden,
        ProjectPolicyForbidden: forbidden,
        WorkspacePolicyDenied: forbidden,
        PersistenceUnavailable: () => notReady("persistence"),
        RunnerProfileConfigurationUnavailable: () =>
          notReady("runner-profile-configuration"),
        RunnerProfileUnavailable: () => notReady("runner-profile"),
      }),
      Match.orElse((error) => {
        throw error;
      }),
    );
  }

  let move: ProjectMove;
  try {
    move = await moveProject(db, {
      projectId,
      userId: principal.userId,
      workspaceId: prepared.success.workspaceId,
      revision: body.value.revision,
      runnerProfileId: prepared.success.runnerProfileId,
      publicCodeEnabled: prepared.success.publicCodeEnabled,
    });
  } catch (cause) {
    if (cause instanceof ProjectMoveNotFound) return notFound();
    if (cause instanceof ProjectMoveNameConflict)
      return failure(MoveProjectNameConflictResponseSchema, 409);
    projectPersistenceLogger.error("Project move failed.", {
      event: "project_move_failed",
      requestId,
      projectId,
      cause,
    });
    return unavailable();
  }

  const background = (task: () => Promise<unknown>) =>
    context.executionCtx.waitUntil(task().catch(() => undefined));
  for (const threadId of move.personalOrbThreadIds)
    background(() =>
      ExecutionWorkspaces.archive(threadId).catch((cause) => {
        projectPersistenceLogger.warn("Moved project Orb stop failed.", {
          event: "project_move_orb_stop_failed",
          requestId,
          threadId,
          cause,
        });
      }),
    );
  // Open apps show the Threads under the workspace.
  if (move.threadIds.length > 0)
    background(async () => {
      for (const threadId of move.threadIds)
        await publishRealtimeInvalidation(
          context.env,
          threadId,
          "thread.invalidated",
        ).catch(() => undefined);
    });

  const moved = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        return yield* (yield* ProjectService).get(principal, projectId);
      }).pipe(Effect.provide(projectService)),
    ),
  );
  if (Result.isFailure(moved)) return unavailable();
  return context.json(
    Schema.encodeUnknownSync(MoveProjectResponseSchema)({
      status: "success",
      data: {
        project: projectData(moved.success),
        stoppedOrbCount: move.personalOrbThreadIds.length,
      },
    }),
    200,
  );
});
/**
 * `POST /v1/projects/:projectId/delete`: the project's creator, or a
 * workspace admin for a workspace project, deletes it for good (#1128).
 * After the response, kept Threads' Orbs stop, deleted Threads are purged
 * (the cron retries what does not finish), open apps refresh each changed
 * Thread, and the icon is removed.
 */
projectRoutes.post("/:projectId/delete", async (context) => {
  const requestId = context.get("requestId");
  const unavailable = () =>
    context.json(
      Schema.encodeUnknownSync(
        DeleteProjectPersistenceUnavailableResponseSchema,
      )({
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "Persistence is temporarily unavailable.",
          requestId,
        },
      }),
      503,
    );
  const params = Schema.decodeUnknownOption(DeleteProjectParamsSchema)({
    projectId: context.req.param("projectId"),
  });
  const body = Schema.decodeUnknownOption(DeleteProjectRequestSchema)(
    await context.req.json().catch(() => undefined),
  );
  if (Option.isNone(params) || Option.isNone(body))
    return context.json(
      Schema.encodeUnknownSync(DeleteProjectInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_REQUEST",
          message: "Request validation failed.",
          requestId,
        },
      }),
      400,
    );
  const db = context.env.DB;
  if (db === undefined) return unavailable();
  let deletion: ProjectDeletion;
  try {
    deletion = await deleteProject(
      db,
      context.get("principal").userId,
      params.value.projectId,
      body.value,
    );
  } catch (cause) {
    if (cause instanceof ProjectDeletionNotFound)
      return context.json(
        Schema.encodeUnknownSync(DeleteProjectNotFoundResponseSchema)({
          status: "error",
          data: {
            code: "PROJECT_NOT_FOUND",
            message: "Project not found.",
            requestId,
          },
        }),
        404,
      );
    if (cause instanceof ProjectDeletionNameMismatch)
      return context.json(
        Schema.encodeUnknownSync(DeleteProjectNameMismatchResponseSchema)({
          status: "error",
          data: {
            code: "PROJECT_NAME_MISMATCH",
            message: "Type the project name to confirm.",
            requestId,
          },
        }),
        400,
      );
    projectPersistenceLogger.error("Project deletion failed.", {
      event: "project_delete_failed",
      requestId,
      projectId: params.value.projectId,
      cause,
    });
    return unavailable();
  }
  const background = (task: () => Promise<unknown>) =>
    context.executionCtx.waitUntil(task().catch(() => undefined));
  for (const threadId of deletion.runningKeptThreadIds)
    background(() =>
      ExecutionWorkspaces.archive(threadId).catch((cause) => {
        projectPersistenceLogger.warn("Kept Thread Orb stop failed.", {
          event: "project_delete_orb_stop_failed",
          requestId,
          threadId,
          cause,
        });
      }),
    );
  if (deletion.deletedThreads.length > 0) {
    const cleanup = deployedThreadCleanup(context.env);
    const pending = [...deletion.deletedThreads];
    // A few at a time: each one calls its Orb provider.
    background(() =>
      Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          for (
            let next = pending.shift();
            next !== undefined;
            next = pending.shift()
          )
            await purgeDeletedThread(
              context.env,
              cleanup,
              next.threadId,
              next.ownerUserId as UserId,
            ).catch((cause) => {
              projectPersistenceLogger.warn(
                "Deleted project Thread purge failed.",
                {
                  event: "project_delete_thread_purge_failed",
                  requestId,
                  threadId: next.threadId,
                  cause,
                },
              );
            });
        }),
      ),
    );
  }
  // Open apps drop deleted Threads and show kept ones archived.
  if (deletion.changedThreadIds.length > 0)
    background(async () => {
      for (const threadId of deletion.changedThreadIds)
        await publishRealtimeInvalidation(
          context.env,
          threadId,
          "thread.invalidated",
        ).catch(() => undefined);
    });
  const iconKey = deletion.iconKey;
  const storage = context.env.DX_STORAGE;
  if (iconKey !== undefined && storage !== undefined)
    background(() => storage.delete(iconKey));
  return context.json(
    Schema.encodeUnknownSync(DeleteProjectResponseSchema)({
      status: "success",
      data: {
        deleted: true,
        keptThreadCount: deletion.keptThreadCount,
        deletedThreadCount: deletion.deletedThreadCount,
      },
    }),
    200,
  );
});
