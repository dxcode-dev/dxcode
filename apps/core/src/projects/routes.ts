import {
  CreateProjectForbiddenResponseSchema,
  CreateProjectInvalidRequestResponseSchema,
  CreateProjectNameConflictResponseSchema,
  CreateProjectPersistenceUnavailableResponseSchema,
  CreateProjectPolicyDeniedResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateProjectRunnerUnavailableResponseSchema,
  GetProjectInvalidRequestResponseSchema,
  GetProjectNotFoundResponseSchema,
  GetProjectParamsSchema,
  GetProjectPersistenceUnavailableResponseSchema,
  GetProjectResponseSchema,
  ListProjectsInvalidRequestResponseSchema,
  ListProjectsPersistenceUnavailableResponseSchema,
  ListProjectsQuerySchema,
  ListProjectsResponseSchema,
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
  canonicalBitbucketRepositoryLocator,
  canonicalGitHubRepositoryLocator,
  canonicalPublicGitRepositoryLocator,
  PersistenceUnavailable,
  type Project,
  type ProjectAdditionalRepository,
  projectAdditionalRepositoryFromUrl,
  SourceControlAccessDenied,
  SourceControlProviderFailure,
  type WorkspacePolicyDenied,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Match, Result, Schema } from "effect";
import { Hono } from "hono";
import {
  loadRunnerProfileCatalog,
  selectRunnerProfile,
} from "../execution/runner-profiles/catalog.js";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../http/request-decoding.js";
import type { AppEnv } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { SettingsAudit } from "../settings/audit.js";
import { signingBackendCapabilities } from "../settings/keys/backend.js";
import { projectDefaultsLayersFor } from "../settings/project-defaults/routes.js";
import { ProjectDefaultsService } from "../settings/project-defaults/service.js";
import { SettingsService } from "../settings/service.js";
import { WorkspaceRepositoryD1 } from "../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../settings/workspace-policy/service.js";
import { authorizeSource } from "../source-control/admission.js";
import { projectViewerAccess } from "./access.js";
import { ProjectRepositoryD1 } from "./repository-d1.js";
import { ProjectService } from "./service.js";

class InvalidProjectRequest extends Schema.TaggedError<InvalidProjectRequest>()(
  "InvalidProjectRequest",
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

const readLimitedRequestBody = Effect.fn("readLimitedRequestBody")(function* (
  request: Request,
  maxBytes: number,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error("Request body exceeds the size limit.");
      }
      const reader = request.body?.getReader();
      if (reader === undefined) return new ArrayBuffer(0);
      const chunks: Array<Uint8Array> = [];
      let length = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new Error("Request body exceeds the size limit.");
        }
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes.buffer;
    },
    catch: () => new InvalidProjectRequest(),
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
          bindingRevision: (current.repository?.bindingRevision ?? 0) + 1,
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
          bindingRevision: (current.repository?.bindingRevision ?? 0) + 1,
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
          configuration,
        },
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

projectRoutes.put("/:projectId/icon", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const { projectId } = yield* decodeRequestInput(
      UpdateProjectParamsSchema,
      { projectId: context.req.param("projectId") },
      () => new InvalidProjectRequest(),
    );
    const contentType = context.req.header("content-type") ?? "";
    const revision = Number(context.req.header("x-project-revision"));
    if (
      !new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType) ||
      !Number.isInteger(revision)
    ) {
      return yield* new InvalidProjectRequest();
    }
    const bytes = yield* readLimitedRequestBody(context.req.raw, 512 * 1024);
    if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1024) {
      return yield* new InvalidProjectRequest();
    }
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
    const extension =
      contentType === "image/png"
        ? "png"
        : contentType === "image/jpeg"
          ? "jpg"
          : "webp";
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
