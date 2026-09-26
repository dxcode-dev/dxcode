import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type { RunnerProfileId } from "./runner-profile.js";
import type { WorkspaceId } from "./workspace.js";
import type {
  WorkspacePolicy,
  WorkspacePolicyUpdate,
} from "./workspace-policy.js";

export class WorkspacePolicyConflict extends Schema.TaggedError<WorkspacePolicyConflict>()(
  "WorkspacePolicyConflict",
  { currentRevision: Schema.Int },
) {}

export interface WorkspacePolicyAuditRecord {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly requestId: string;
  readonly outcome: "success" | "rejected";
  readonly reason?: string;
  readonly previousRevision: number;
  readonly nextRevision?: number;
  readonly changedFields: ReadonlyArray<string>;
  readonly createdAt: string;
}

export interface WorkspacePolicyRepositoryShape {
  readonly get: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    WorkspacePolicy,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly put: (
    workspaceId: WorkspaceId,
    input: WorkspacePolicyUpdate,
    expectedRevision: number,
    audit: WorkspacePolicyAuditRecord,
  ) => Effect.Effect<
    WorkspacePolicy,
    PersistenceUnavailable | Schema.SchemaError | WorkspacePolicyConflict
  >;
  readonly recordRejected: (
    audit: WorkspacePolicyAuditRecord,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  readonly allowedRunnerProfileIds: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<RunnerProfileId> | null,
    PersistenceUnavailable | Schema.SchemaError
  >;
}

export class WorkspacePolicyRepository extends Context.Service<
  WorkspacePolicyRepository,
  WorkspacePolicyRepositoryShape
>()("@dx/domain/settings/WorkspacePolicyRepository") {}
