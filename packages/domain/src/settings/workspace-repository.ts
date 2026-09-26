import { Context, type Effect, type Option, type Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  SettingsMembershipInvariantViolation,
  WorkspaceMembershipExists,
  WorkspaceNotFound,
  WorkspaceProfileConflict,
  WorkspaceShortNameUnavailable,
} from "./errors.js";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceProfileInput,
  WorkspaceId,
  WorkspaceMembership,
  WorkspaceProfile,
  WorkspaceProfileRevision,
} from "./workspace.js";

export interface WorkspaceRepositoryShape {
  readonly findByUser: (
    userId: UserId,
  ) => Effect.Effect<
    Option.Option<WorkspaceMembership>,
    | Schema.SchemaError
    | PersistenceUnavailable
    | SettingsMembershipInvariantViolation
  >;
  readonly createOwnedByUser: (
    userId: UserId,
    input: CreateWorkspaceInput,
  ) => Effect.Effect<
    WorkspaceMembership,
    | Schema.SchemaError
    | PersistenceUnavailable
    | SettingsMembershipInvariantViolation
    | WorkspaceMembershipExists
    | WorkspaceShortNameUnavailable
  >;
  readonly updateProfile: (
    workspaceId: WorkspaceId,
    input: UpdateWorkspaceProfileInput,
    expectedRevision: WorkspaceProfileRevision,
  ) => Effect.Effect<
    WorkspaceProfile,
    | Schema.SchemaError
    | PersistenceUnavailable
    | WorkspaceNotFound
    | WorkspaceProfileConflict
    | WorkspaceShortNameUnavailable
  >;
}

export class WorkspaceRepository extends Context.Service<
  WorkspaceRepository,
  WorkspaceRepositoryShape
>()("@dx/domain/settings/WorkspaceRepository") {}
