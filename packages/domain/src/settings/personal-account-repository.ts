import { Context, type Effect, type Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  PersonalAccountNotFound,
  PersonalAccountUsernameUnavailable,
} from "./errors.js";
import type {
  PersonalAccount,
  PersonalComposerDefaults,
  UpdatePersonalAccountInput,
  UpdatePersonalAppearanceInput,
  UpdatePersonalComposerDefaultsInput,
} from "./personal-account.js";

export interface PersonalAccountRepositoryShape {
  readonly findOwnedByUser: (
    userId: UserId,
  ) => Effect.Effect<
    PersonalAccount,
    Schema.SchemaError | PersistenceUnavailable | PersonalAccountNotFound
  >;
  readonly updateOwnedByUser: (
    userId: UserId,
    input: UpdatePersonalAccountInput,
  ) => Effect.Effect<
    PersonalAccount,
    | Schema.SchemaError
    | PersistenceUnavailable
    | PersonalAccountNotFound
    | PersonalAccountUsernameUnavailable
  >;
  readonly updateAppearanceOwnedByUser: (
    userId: UserId,
    input: UpdatePersonalAppearanceInput,
  ) => Effect.Effect<
    PersonalAccount,
    Schema.SchemaError | PersistenceUnavailable | PersonalAccountNotFound
  >;
  readonly findComposerDefaultsOwnedByUser: (
    userId: UserId,
  ) => Effect.Effect<
    PersonalComposerDefaults,
    Schema.SchemaError | PersistenceUnavailable | PersonalAccountNotFound
  >;
  readonly updateComposerDefaultsOwnedByUser: (
    userId: UserId,
    input: UpdatePersonalComposerDefaultsInput,
  ) => Effect.Effect<
    PersonalComposerDefaults,
    Schema.SchemaError | PersistenceUnavailable | PersonalAccountNotFound
  >;
}

export class PersonalAccountRepository extends Context.Service<
  PersonalAccountRepository,
  PersonalAccountRepositoryShape
>()("@dx/domain/settings/PersonalAccountRepository") {}
