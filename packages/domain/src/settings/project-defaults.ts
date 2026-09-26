import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { RunnerProfileId } from "./runner-profile.js";
import { WorkspaceId } from "./workspace.js";

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProjectShipAction = Schema.Literals(["ship", "commit"]);

export type ProjectShipAction = typeof ProjectShipAction.Type;

export const CommitAuthorPreference = Schema.Literals(["dx", "user"]);

export type CommitAuthorPreference = typeof CommitAuthorPreference.Type;

export const CommitSigningPreference = Schema.Literals([
  "disabled",
  "preferred",
  "required",
]);

export type CommitSigningPreference = typeof CommitSigningPreference.Type;

export const ProjectDefaultSource = Schema.Literals([
  "deployment",
  "personal",
  "workspace",
]);

export type ProjectDefaultSource = typeof ProjectDefaultSource.Type;

export const GitAuthorName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[^\r\n<>]+$/),
);

export const GitAuthorEmail = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(254),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);

export const ProjectCommitAuthor = Schema.Struct({
  preference: CommitAuthorPreference,
  name: GitAuthorName,
  email: GitAuthorEmail,
});

export type ProjectCommitAuthor = typeof ProjectCommitAuthor.Type;

export const ProjectConfiguration = Schema.Struct({
  shipAction: ProjectShipAction,
  commitAuthor: ProjectCommitAuthor,
  signingPreference: CommitSigningPreference,
  runnerProfileId: RunnerProfileId,
  publicCodeEnabled: Schema.Boolean,
});

export type ProjectConfiguration = typeof ProjectConfiguration.Type;

export const ProjectDefaultOverrides = Schema.Struct({
  shipAction: Schema.NullOr(ProjectShipAction),
  commitAuthor: Schema.NullOr(CommitAuthorPreference),
  signingPreference: Schema.NullOr(CommitSigningPreference),
  runnerProfileId: Schema.NullOr(RunnerProfileId),
});

export type ProjectDefaultOverrides = typeof ProjectDefaultOverrides.Type;

export const PersonalProjectDefaults = Schema.Struct({
  userId: UserId,
  overrides: ProjectDefaultOverrides,
  revision: Revision,
  updatedAt: Schema.NullOr(Timestamp),
});

export type PersonalProjectDefaults = typeof PersonalProjectDefaults.Type;

export const WorkspaceProjectPolicy = Schema.Struct({
  allowMemberProjectCreation: Schema.Boolean,
  allowPublicCodeAccess: Schema.Boolean,
  allowedRunnerProfileIds: Schema.NullOr(Schema.Array(RunnerProfileId)),
});

export type WorkspaceProjectPolicy = typeof WorkspaceProjectPolicy.Type;

export const WorkspaceProjectDefaults = Schema.Struct({
  workspaceId: WorkspaceId,
  overrides: ProjectDefaultOverrides,
  policy: WorkspaceProjectPolicy,
  revision: Revision,
  updatedAt: Schema.NullOr(Timestamp),
});

export type WorkspaceProjectDefaults = typeof WorkspaceProjectDefaults.Type;

export const ResolvedProjectDefaults = Schema.Struct({
  shipAction: Schema.Struct({
    value: ProjectShipAction,
    source: ProjectDefaultSource,
  }),
  commitAuthor: Schema.Struct({
    value: CommitAuthorPreference,
    source: ProjectDefaultSource,
  }),
  signingPreference: Schema.Struct({
    value: CommitSigningPreference,
    source: ProjectDefaultSource,
  }),
  runnerProfileId: Schema.Struct({
    value: RunnerProfileId,
    source: ProjectDefaultSource,
  }),
});

export type ResolvedProjectDefaults = typeof ResolvedProjectDefaults.Type;

export class ProjectDefaultsConflict extends Schema.TaggedError<ProjectDefaultsConflict>()(
  "ProjectDefaultsConflict",
  {},
) {}

export interface ProjectDefaultsRepositoryShape {
  readonly getPersonal: (
    userId: UserId,
  ) => Effect.Effect<
    PersonalProjectDefaults,
    Schema.SchemaError | PersistenceUnavailable
  >;
  readonly putPersonal: (
    userId: UserId,
    overrides: ProjectDefaultOverrides,
    expectedRevision: number,
  ) => Effect.Effect<
    PersonalProjectDefaults,
    Schema.SchemaError | PersistenceUnavailable | ProjectDefaultsConflict
  >;
  readonly getWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    WorkspaceProjectDefaults,
    Schema.SchemaError | PersistenceUnavailable
  >;
  readonly putWorkspace: (
    workspaceId: WorkspaceId,
    overrides: ProjectDefaultOverrides,
    policy: WorkspaceProjectPolicy,
    expectedRevision: number,
  ) => Effect.Effect<
    WorkspaceProjectDefaults,
    Schema.SchemaError | PersistenceUnavailable | ProjectDefaultsConflict
  >;
}

export class ProjectDefaultsRepository extends Context.Service<
  ProjectDefaultsRepository,
  ProjectDefaultsRepositoryShape
>()("@dx/domain/settings/ProjectDefaultsRepository") {}
