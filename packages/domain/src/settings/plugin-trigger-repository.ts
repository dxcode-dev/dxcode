import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  PluginTriggerCapabilityHash,
  PluginTriggerId,
  PluginTriggerStatus,
  StoredPluginTrigger,
} from "./plugin-trigger.js";

export class PluginTriggerNotFound extends Schema.TaggedError<PluginTriggerNotFound>()(
  "PluginTriggerNotFound",
  {},
) {}

export class PluginTriggerLimitExceeded extends Schema.TaggedError<PluginTriggerLimitExceeded>()(
  "PluginTriggerLimitExceeded",
  {},
) {}

export class PluginTriggerCapabilityForbidden extends Schema.TaggedError<PluginTriggerCapabilityForbidden>()(
  "PluginTriggerCapabilityForbidden",
  {},
) {}

export class PluginTriggerConflict extends Schema.TaggedError<PluginTriggerConflict>()(
  "PluginTriggerConflict",
  {},
) {}

type PluginTriggerRepositoryFailure =
  | PersistenceUnavailable
  | Schema.SchemaError;

export interface PluginTriggerAuditRecord {
  readonly auditId: string;
  readonly triggerId: PluginTriggerId;
  readonly ownerUserId: UserId;
  readonly action: string;
  readonly outcome: "success" | "rejected";
  readonly requestId: string;
  readonly createdAt: StoredPluginTrigger["createdAt"];
}

export interface PluginTriggerRepositoryShape {
  readonly list: (
    ownerUserId: UserId,
  ) => Effect.Effect<
    ReadonlyArray<StoredPluginTrigger>,
    PluginTriggerRepositoryFailure
  >;
  readonly find: (
    ownerUserId: UserId,
    id: PluginTriggerId,
  ) => Effect.Effect<
    StoredPluginTrigger,
    PluginTriggerRepositoryFailure | PluginTriggerNotFound
  >;
  readonly findIngress: (
    id: PluginTriggerId,
  ) => Effect.Effect<
    StoredPluginTrigger,
    PluginTriggerRepositoryFailure | PluginTriggerNotFound
  >;
  readonly insert: (
    trigger: StoredPluginTrigger,
  ) => Effect.Effect<
    void,
    PluginTriggerRepositoryFailure | PluginTriggerConflict
  >;
  readonly updateStatus: (
    ownerUserId: UserId,
    id: PluginTriggerId,
    status: PluginTriggerStatus,
    updatedAt: StoredPluginTrigger["updatedAt"],
  ) => Effect.Effect<
    void,
    PluginTriggerRepositoryFailure | PluginTriggerNotFound
  >;
  readonly rotateCapability: (
    ownerUserId: UserId,
    id: PluginTriggerId,
    hash: PluginTriggerCapabilityHash,
    rotatedAt: StoredPluginTrigger["rotatedAt"],
  ) => Effect.Effect<
    void,
    PluginTriggerRepositoryFailure | PluginTriggerNotFound
  >;
  readonly recordAudit: (
    record: PluginTriggerAuditRecord,
  ) => Effect.Effect<void, PluginTriggerRepositoryFailure>;
}

export class PluginTriggerRepository extends Context.Service<
  PluginTriggerRepository,
  PluginTriggerRepositoryShape
>()("@dx/domain/settings/PluginTriggerRepository") {}
