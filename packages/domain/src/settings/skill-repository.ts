import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { ProjectId } from "../projects/project-id.js";
import type { UserId } from "../users/user-id.js";
import type {
  SkillId,
  SkillTarget,
  SkillVersion,
  SkillWithVersion,
  StoredSkill,
  StoredSkillVersion,
} from "./skill.js";
import type { WorkspaceId } from "./workspace.js";

export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()(
  "SkillNotFound",
  {},
) {}

export class SkillLimitExceeded extends Schema.TaggedError<SkillLimitExceeded>()(
  "SkillLimitExceeded",
  {},
) {}

export class SkillIntegrityConflict extends Schema.TaggedError<SkillIntegrityConflict>()(
  "SkillIntegrityConflict",
  {},
) {}

export class SkillMcpReferenceInvalid extends Schema.TaggedError<SkillMcpReferenceInvalid>()(
  "SkillMcpReferenceInvalid",
  {},
) {}

type SkillRepositoryFailure = PersistenceUnavailable | Schema.SchemaError;

export interface SkillRepositoryShape {
  readonly list: (
    target: SkillTarget,
  ) => Effect.Effect<ReadonlyArray<SkillWithVersion>, SkillRepositoryFailure>;
  readonly find: (
    target: SkillTarget,
    id: SkillId,
  ) => Effect.Effect<SkillWithVersion, SkillRepositoryFailure | SkillNotFound>;
  readonly findVersion: (
    id: SkillId,
    version: SkillVersion,
  ) => Effect.Effect<
    StoredSkillVersion,
    SkillRepositoryFailure | SkillNotFound
  >;
  readonly insert: (
    skill: StoredSkill,
    version: StoredSkillVersion,
  ) => Effect.Effect<void, SkillRepositoryFailure | SkillIntegrityConflict>;
  readonly insertVersion: (
    target: SkillTarget,
    version: StoredSkillVersion,
    activate: boolean,
    updatedAt: StoredSkill["updatedAt"],
  ) => Effect.Effect<
    void,
    SkillRepositoryFailure | SkillNotFound | SkillIntegrityConflict
  >;
  readonly updateState: (
    target: SkillTarget,
    id: SkillId,
    input: {
      readonly enabled?: boolean;
      readonly activeVersion?: SkillVersion;
      readonly pinned?: boolean;
      readonly removedAt?: StoredSkill["removedAt"];
    },
    updatedAt: StoredSkill["updatedAt"],
  ) => Effect.Effect<void, SkillRepositoryFailure | SkillNotFound>;
  readonly listEffectiveForThread: (
    ownerUserId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<SkillWithVersion>, SkillRepositoryFailure>;
  readonly getWorkspacePolicy: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<boolean, SkillRepositoryFailure>;
  readonly setWorkspacePolicy: (
    workspaceId: WorkspaceId,
    allowPersonal: boolean,
  ) => Effect.Effect<void, SkillRepositoryFailure>;
}

export class SkillRepository extends Context.Service<
  SkillRepository,
  SkillRepositoryShape
>()("@dx/domain/settings/SkillRepository") {}
