import { Context, type Effect, type Schema } from "effect";
import type { Page, PageRequest } from "../pagination/page.js";
import type {
  InvalidPageCursor,
  PersistenceUnavailable,
  ProjectNameConflict,
  ProjectNotFound,
} from "../persistence/errors.js";
import type { ProjectConfiguration } from "../settings/project-defaults.js";
import type { WorkspaceId } from "../settings/workspace.js";
import type { ProjectSourceAuthority } from "../source-control/source-control.js";
import type { UserId } from "../users/user-id.js";
import type { Project, ProjectRepositoryIdentity } from "./project.js";
import type { ProjectId } from "./project-id.js";

export interface ProjectUpdate {
  readonly name?: Project["name"];
  readonly description?: Project["description"];
  readonly iconKey?: Project["iconKey"];
  readonly configuration?: Project["configuration"];
}

export interface ProjectRepositoryShape {
  readonly ensureProjectless: (
    ownerUserId: UserId,
    snapshot: {
      readonly workspaceId?: WorkspaceId;
      readonly configuration: ProjectConfiguration;
    },
  ) => Effect.Effect<ProjectId, PersistenceUnavailable>;
  readonly insert: (
    project: Project,
    authority?: ProjectSourceAuthority,
  ) => Effect.Effect<
    void,
    Schema.SchemaError | PersistenceUnavailable | ProjectNameConflict
  >;
  readonly findOwnedById: (
    projectId: ProjectId,
    ownerUserId: UserId,
  ) => Effect.Effect<
    Project,
    Schema.SchemaError | PersistenceUnavailable | ProjectNotFound
  >;
  readonly listOwned: (
    ownerUserId: UserId,
    request: PageRequest,
  ) => Effect.Effect<
    Page<Project>,
    Schema.SchemaError | PersistenceUnavailable | InvalidPageCursor
  >;
  readonly updateOwned: (
    projectId: ProjectId,
    ownerUserId: UserId,
    revision: number,
    update: ProjectUpdate,
  ) => Effect.Effect<
    Project,
    | Schema.SchemaError
    | PersistenceUnavailable
    | ProjectNotFound
    | ProjectNameConflict
  >;
  readonly rebindRepositoryOwned: (
    projectId: ProjectId,
    ownerUserId: UserId,
    revision: number,
    repository: ProjectRepositoryIdentity,
    authority: ProjectSourceAuthority,
  ) => Effect.Effect<
    Project,
    Schema.SchemaError | PersistenceUnavailable | ProjectNotFound
  >;
}

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  ProjectRepositoryShape
>()("@dx/domain/projects/ProjectRepository") {}
