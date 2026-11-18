import { Context, type Effect, type Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  PersonalAccountNotFound,
  PersonalAccountUsernameChangeLocked,
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
  /**
   * Saves the name and username only while the stored username is still
   * `username.expected`, so two saves cannot both spend the one change. A new
   * username must be free and never retired; with `usesChange` the save also
   * spends the change and fails when it is already spent. The database
   * retires the old username in the same statement (migration 0202).
   */
  readonly updateOwnedByUser: (
    userId: UserId,
    input: UpdatePersonalAccountInput,
    username: { readonly expected: string; readonly usesChange: boolean },
  ) => Effect.Effect<
    PersonalAccount,
    | Schema.SchemaError
    | PersistenceUnavailable
    | PersonalAccountNotFound
    | PersonalAccountUsernameChangeLocked
    | PersonalAccountUsernameUnavailable
  >;
  /** Gives the person their one username change back. */
  readonly resetUsernameChange: (
    userId: UserId,
  ) => Effect.Effect<
    PersonalAccount,
    Schema.SchemaError | PersistenceUnavailable | PersonalAccountNotFound
  >;
  readonly updateAppearanceOwnedByUser: (
    userId: UserId,
    input: UpdatePersonalAppearanceInput,
  ) => Effect.Effect<
    PersonalAccount,
    Schema.SchemaError | PersistenceUnavailable | PersonalAccountNotFound
  >;
  /**
   * How many Threads the user owns. It reads every one, so only Account
   * settings asks for it, never the account read every page waits on.
   */
  readonly countThreadsOwnedByUser: (
    userId: UserId,
  ) => Effect.Effect<number, PersistenceUnavailable>;
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
