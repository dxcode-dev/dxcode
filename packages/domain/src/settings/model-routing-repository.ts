import { Context, type Effect, type Option, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  ModeId,
  ModelConnectionId,
  ModelConnectionTarget,
  ModeProfileOverride,
  ProfileId,
  StoredModelConnection,
} from "./model-routing.js";

export class ModelConnectionNotFound extends Schema.TaggedError<ModelConnectionNotFound>()(
  "ModelConnectionNotFound",
  {},
) {}

export interface ModelRoutingRepositoryShape {
  readonly listConnections: (
    target: ModelConnectionTarget,
  ) => Effect.Effect<
    ReadonlyArray<StoredModelConnection>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly findConnection: (
    target: ModelConnectionTarget,
    id: ModelConnectionId,
  ) => Effect.Effect<
    StoredModelConnection,
    PersistenceUnavailable | Schema.SchemaError | ModelConnectionNotFound
  >;
  readonly insertConnection: (
    connection: StoredModelConnection,
  ) => Effect.Effect<void, PersistenceUnavailable | Schema.SchemaError>;
  readonly replaceConnection: (
    connection: StoredModelConnection,
  ) => Effect.Effect<
    void,
    PersistenceUnavailable | Schema.SchemaError | ModelConnectionNotFound
  >;
  /**
   * Rewrites `priority` to match `orderedIds`. Every connection in the target
   * scope must appear exactly once; extra or missing ids fail persistence.
   */
  readonly reorderConnections: (
    target: ModelConnectionTarget,
    orderedIds: ReadonlyArray<ModelConnectionId>,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  /**
   * Deletes the connection together with its credential, declared models, and
   * headers. Deleting a connection never blocks on usage.
   */
  readonly removeConnection: (
    target: ModelConnectionTarget,
    id: ModelConnectionId,
  ) => Effect.Effect<
    void,
    PersistenceUnavailable | Schema.SchemaError | ModelConnectionNotFound
  >;
}

export class ModelRoutingRepository extends Context.Service<
  ModelRoutingRepository,
  ModelRoutingRepositoryShape
>()("@dx/domain/settings/ModelRoutingRepository") {}

export interface ModeProfileOverrideRepositoryShape {
  readonly listOverrides: (
    userId: UserId,
    profileId: ProfileId,
  ) => Effect.Effect<
    ReadonlyArray<ModeProfileOverride>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly findOverride: (
    userId: UserId,
    profileId: ProfileId,
    mode: ModeId,
  ) => Effect.Effect<
    Option.Option<ModeProfileOverride>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly upsertOverride: (
    override: ModeProfileOverride,
  ) => Effect.Effect<void, PersistenceUnavailable | Schema.SchemaError>;
  /** Deleting an override resets the mode to the shipped default. */
  readonly removeOverride: (
    userId: UserId,
    profileId: ProfileId,
    mode: ModeId,
  ) => Effect.Effect<void, PersistenceUnavailable>;
}

export class ModeProfileOverrideRepository extends Context.Service<
  ModeProfileOverrideRepository,
  ModeProfileOverrideRepositoryShape
>()("@dx/domain/settings/ModeProfileOverrideRepository") {}
