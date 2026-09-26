import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { ProjectId } from "../projects/project-id.js";
import type { ThreadId } from "../threads/thread-id.js";
import type { UserId } from "../users/user-id.js";
import type {
  PluginId,
  PluginTarget,
  PluginVersion,
  PluginWithVersion,
  StoredPlugin,
  StoredPluginVersion,
} from "./plugin.js";
import type { WorkspaceId } from "./workspace.js";

export class PluginNotFound extends Schema.TaggedError<PluginNotFound>()(
  "PluginNotFound",
  {},
) {}

export class PluginLimitExceeded extends Schema.TaggedError<PluginLimitExceeded>()(
  "PluginLimitExceeded",
  {},
) {}

export class PluginIntegrityConflict extends Schema.TaggedError<PluginIntegrityConflict>()(
  "PluginIntegrityConflict",
  {},
) {}

export class PluginPermissionInvalid extends Schema.TaggedError<PluginPermissionInvalid>()(
  "PluginPermissionInvalid",
  { permission: Schema.String },
) {}

export class PluginInvocationForbidden extends Schema.TaggedError<PluginInvocationForbidden>()(
  "PluginInvocationForbidden",
  {},
) {}

type PluginRepositoryFailure = PersistenceUnavailable | Schema.SchemaError;

export interface PluginRepositoryShape {
  readonly list: (
    target: PluginTarget,
  ) => Effect.Effect<ReadonlyArray<PluginWithVersion>, PluginRepositoryFailure>;
  readonly find: (
    target: PluginTarget,
    id: PluginId,
  ) => Effect.Effect<
    PluginWithVersion,
    PluginRepositoryFailure | PluginNotFound
  >;
  readonly findVersion: (
    id: PluginId,
    version: PluginVersion,
  ) => Effect.Effect<
    StoredPluginVersion,
    PluginRepositoryFailure | PluginNotFound
  >;
  readonly insert: (
    plugin: StoredPlugin,
    version: StoredPluginVersion,
  ) => Effect.Effect<void, PluginRepositoryFailure | PluginIntegrityConflict>;
  readonly insertVersion: (
    target: PluginTarget,
    version: StoredPluginVersion,
    activate: boolean,
    updatedAt: StoredPlugin["updatedAt"],
  ) => Effect.Effect<
    void,
    PluginRepositoryFailure | PluginNotFound | PluginIntegrityConflict
  >;
  readonly updateState: (
    target: PluginTarget,
    id: PluginId,
    input: {
      readonly enabled?: boolean;
      readonly activeVersion?: PluginVersion;
      readonly healthStatus?: StoredPlugin["healthStatus"];
      readonly removedAt?: StoredPlugin["removedAt"];
    },
    updatedAt: StoredPlugin["updatedAt"],
  ) => Effect.Effect<void, PluginRepositoryFailure | PluginNotFound>;
  readonly listEffectiveForThread: (
    ownerUserId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<PluginWithVersion>, PluginRepositoryFailure>;
  readonly listEffectiveForUser: (
    ownerUserId: UserId,
  ) => Effect.Effect<ReadonlyArray<PluginWithVersion>, PluginRepositoryFailure>;
  readonly findAuthorizedInvocation: (
    threadId: ThreadId,
    pluginId: PluginId,
    version: PluginVersion,
  ) => Effect.Effect<
    PluginWithVersion,
    PluginRepositoryFailure | PluginInvocationForbidden
  >;
  readonly recordInvocation: (input: {
    readonly invocationId: string;
    readonly threadId: ThreadId;
    readonly pluginId: PluginId;
    readonly version: PluginVersion;
    readonly capabilityKind: "tool" | "lifecycle";
    readonly capabilityName: string;
    readonly outcome: "success" | "rejected" | "failed" | "limited";
    readonly durationMs: number;
    readonly createdAt: StoredPlugin["updatedAt"];
  }) => Effect.Effect<void, PluginRepositoryFailure>;
  readonly getWorkspacePolicy: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<boolean, PluginRepositoryFailure>;
  readonly setWorkspacePolicy: (
    workspaceId: WorkspaceId,
    allowPersonal: boolean,
  ) => Effect.Effect<void, PluginRepositoryFailure>;
}

export class PluginRepository extends Context.Service<
  PluginRepository,
  PluginRepositoryShape
>()("@dx/domain/settings/PluginRepository") {}
