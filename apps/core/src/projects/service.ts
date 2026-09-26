import {
  createProject,
  type InvalidPageCursor,
  type Page,
  type PageRequest,
  type PersistenceUnavailable,
  type Principal,
  type Project,
  type ProjectDescription,
  type ProjectId,
  type ProjectNameConflict,
  type ProjectNameInput,
  type ProjectNotFound,
  ProjectRepository,
  type ProjectRepositoryIdentity,
  type ProjectSourceAuthority,
  type ProjectUpdate,
} from "@dx/domain";
import { Context, Effect, Layer, type Schema } from "effect";
import type { ProjectCreationSnapshot } from "../settings/project-defaults/service.js";

interface ProjectServiceShape {
  readonly create: (
    principal: Principal,
    name: ProjectNameInput,
    snapshot: ProjectCreationSnapshot,
    details?: {
      readonly description?: typeof ProjectDescription.Type;
      readonly repository?: typeof ProjectRepositoryIdentity.Type;
      readonly sourceAuthority?: ProjectSourceAuthority;
    },
  ) => Effect.Effect<
    Project,
    Schema.SchemaError | PersistenceUnavailable | ProjectNameConflict
  >;
  readonly get: (
    principal: Principal,
    projectId: ProjectId,
  ) => Effect.Effect<
    Project,
    Schema.SchemaError | PersistenceUnavailable | ProjectNotFound
  >;
  readonly list: (
    principal: Principal,
    request: PageRequest,
  ) => Effect.Effect<
    Page<Project>,
    Schema.SchemaError | PersistenceUnavailable | InvalidPageCursor
  >;
  readonly update: (
    principal: Principal,
    projectId: ProjectId,
    revision: number,
    update: ProjectUpdate,
  ) => Effect.Effect<
    Project,
    | Schema.SchemaError
    | PersistenceUnavailable
    | ProjectNotFound
    | ProjectNameConflict
  >;
  readonly rebindRepository: (
    principal: Principal,
    projectId: ProjectId,
    revision: number,
    repository: ProjectRepositoryIdentity,
    authority: ProjectSourceAuthority,
  ) => Effect.Effect<
    Project,
    Schema.SchemaError | PersistenceUnavailable | ProjectNotFound
  >;
}

export class ProjectService extends Context.Service<
  ProjectService,
  ProjectServiceShape
>()("@dx/core/projects/ProjectService") {
  static readonly layer = Layer.effect(
    ProjectService,
    Effect.gen(function* () {
      const repository = yield* ProjectRepository;

      return ProjectService.of({
        create: Effect.fn("ProjectService.create")(
          function* (principal, name, snapshot, details) {
            const { sourceAuthority, ...projectDetails } = details ?? {};
            const project = yield* createProject({
              ownerUserId: principal.userId,
              name,
              ...projectDetails,
              ...snapshot,
            });
            yield* repository.insert(project, sourceAuthority);
            return project;
          },
        ),
        get: Effect.fn("ProjectService.get")((principal, projectId) =>
          repository.findOwnedById(projectId, principal.userId),
        ),
        list: Effect.fn("ProjectService.list")((principal, request) =>
          repository.listOwned(principal.userId, request),
        ),
        update: Effect.fn("ProjectService.update")(
          (principal, projectId, revision, update) =>
            repository.updateOwned(
              projectId,
              principal.userId,
              revision,
              update,
            ),
        ),
        rebindRepository: Effect.fn("ProjectService.rebindRepository")(
          (principal, projectId, revision, source, authority) =>
            repository.rebindRepositoryOwned(
              projectId,
              principal.userId,
              revision,
              source,
              authority,
            ),
        ),
      });
    }),
  );
}
