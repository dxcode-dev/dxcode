import { Context, type Effect, type Option, Schema } from "effect";
import type { Page, PageRequest } from "../pagination/page.js";
import type {
  InvalidPageCursor,
  PersistenceUnavailable,
} from "../persistence/errors.js";
import type {
  EnvironmentVariableAuditEvent,
  EnvironmentVariableAuditRecord,
  EnvironmentVariableId,
  EnvironmentVariableName,
  EnvironmentVariableTarget,
  StoredEnvironmentVariable,
} from "./environment-variable.js";

export class EnvironmentVariableNotFound extends Schema.TaggedError<EnvironmentVariableNotFound>()(
  "EnvironmentVariableNotFound",
  {},
) {}

export class EnvironmentVariableConflict extends Schema.TaggedError<EnvironmentVariableConflict>()(
  "EnvironmentVariableConflict",
  {},
) {}

export type EnvironmentVariableRepositoryError =
  | PersistenceUnavailable
  | Schema.SchemaError;

export type EnvironmentVariableWrite =
  | {
      readonly operation: "insert";
      readonly value: StoredEnvironmentVariable;
      readonly audit: EnvironmentVariableAuditRecord;
    }
  | {
      readonly operation: "replace";
      readonly value: StoredEnvironmentVariable;
      readonly audit: EnvironmentVariableAuditRecord;
    };

export interface EnvironmentVariableRepositoryShape {
  readonly list: (
    target: EnvironmentVariableTarget,
  ) => Effect.Effect<
    ReadonlyArray<StoredEnvironmentVariable>,
    EnvironmentVariableRepositoryError
  >;
  readonly find: (
    target: EnvironmentVariableTarget,
    id: EnvironmentVariableId,
  ) => Effect.Effect<
    StoredEnvironmentVariable,
    EnvironmentVariableRepositoryError | EnvironmentVariableNotFound
  >;
  readonly findByName: (
    target: EnvironmentVariableTarget,
    name: EnvironmentVariableName,
  ) => Effect.Effect<
    Option.Option<StoredEnvironmentVariable>,
    EnvironmentVariableRepositoryError
  >;
  readonly write: (
    writes: ReadonlyArray<EnvironmentVariableWrite>,
  ) => Effect.Effect<
    void,
    | EnvironmentVariableRepositoryError
    | EnvironmentVariableConflict
    | EnvironmentVariableNotFound
  >;
  readonly remove: (
    target: EnvironmentVariableTarget,
    id: EnvironmentVariableId,
    audit: EnvironmentVariableAuditRecord,
  ) => Effect.Effect<
    void,
    EnvironmentVariableRepositoryError | EnvironmentVariableNotFound
  >;
  readonly listAudit: (
    target: EnvironmentVariableTarget,
    request: PageRequest,
  ) => Effect.Effect<
    Page<EnvironmentVariableAuditEvent>,
    EnvironmentVariableRepositoryError | InvalidPageCursor
  >;
}

export class EnvironmentVariableRepository extends Context.Service<
  EnvironmentVariableRepository,
  EnvironmentVariableRepositoryShape
>()("@dx/domain/settings/EnvironmentVariableRepository") {}
