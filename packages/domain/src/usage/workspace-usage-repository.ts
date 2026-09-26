import { Context, type Effect, type Option, type Schema } from "effect";
import type { PageCursor } from "../pagination/cursor.js";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { WorkspaceId } from "../settings/workspace.js";
import type { ThreadId } from "../threads/thread-id.js";
import type { InvalidUsageQuery } from "./usage.js";
import type {
  NormalizedWorkspaceUsageAuditQuery,
  WorkspacePrivateThreadTarget,
  WorkspaceUsageAuditEvent,
} from "./workspace-usage.js";

export interface WorkspaceUsageAuditPage {
  readonly items: ReadonlyArray<WorkspaceUsageAuditEvent>;
  readonly nextCursor?: PageCursor;
}

export interface WorkspaceUsageAuditRepositoryShape {
  readonly findInspectionTarget: (
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ) => Effect.Effect<
    Option.Option<WorkspacePrivateThreadTarget>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly append: (
    event: Omit<WorkspaceUsageAuditEvent, "actorName">,
  ) => Effect.Effect<void, PersistenceUnavailable | Schema.SchemaError>;
  readonly list: (
    workspaceId: WorkspaceId,
    query: NormalizedWorkspaceUsageAuditQuery,
  ) => Effect.Effect<
    WorkspaceUsageAuditPage,
    InvalidUsageQuery | PersistenceUnavailable | Schema.SchemaError
  >;
}

export class WorkspaceUsageAuditRepository extends Context.Service<
  WorkspaceUsageAuditRepository,
  WorkspaceUsageAuditRepositoryShape
>()("@dx/domain/usage/WorkspaceUsageAuditRepository") {}
