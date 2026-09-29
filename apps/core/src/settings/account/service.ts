import {
  type PersistenceUnavailable,
  type PersonalAccount,
  type PersonalAccountNotFound,
  PersonalAccountRepository,
  type PersonalAccountUsernameUnavailable,
  type PersonalComposerDefaults,
  type Principal,
  type UpdatePersonalAccountInput,
  type UpdatePersonalAppearanceInput,
  type UpdatePersonalComposerDefaultsInput,
} from "@dx/domain";
import { Context, Effect, Layer, type Schema } from "effect";
import { SettingsAudit } from "../audit.js";

type PersonalAccountReadError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | PersonalAccountNotFound;

type PersonalAccountUpdateError =
  | PersonalAccountReadError
  | PersonalAccountUsernameUnavailable;

interface PersonalAccountServiceShape {
  readonly get: (
    principal: Principal,
  ) => Effect.Effect<PersonalAccount, PersonalAccountReadError>;
  readonly update: (
    principal: Principal,
    input: UpdatePersonalAccountInput,
    requestId: string,
  ) => Effect.Effect<PersonalAccount, PersonalAccountUpdateError>;
  readonly updateAppearance: (
    principal: Principal,
    input: UpdatePersonalAppearanceInput,
    requestId: string,
  ) => Effect.Effect<PersonalAccount, PersonalAccountReadError>;
  readonly getComposerDefaults: (
    principal: Principal,
  ) => Effect.Effect<PersonalComposerDefaults, PersonalAccountReadError>;
  /** Not audited: these are remembered UI choices, written on every change. */
  readonly updateComposerDefaults: (
    principal: Principal,
    input: UpdatePersonalComposerDefaultsInput,
  ) => Effect.Effect<PersonalComposerDefaults, PersonalAccountReadError>;
}

export class PersonalAccountService extends Context.Service<
  PersonalAccountService,
  PersonalAccountServiceShape
>()("@dx/core/settings/account/PersonalAccountService") {
  static readonly layer = Layer.effect(
    PersonalAccountService,
    Effect.gen(function* () {
      const accounts = yield* PersonalAccountRepository;
      const audit = yield* SettingsAudit;

      return PersonalAccountService.of({
        get: Effect.fn("PersonalAccountService.get")((principal) =>
          accounts.findOwnedByUser(principal.userId),
        ),
        getComposerDefaults: Effect.fn(
          "PersonalAccountService.getComposerDefaults",
        )((principal) =>
          accounts.findComposerDefaultsOwnedByUser(principal.userId),
        ),
        updateComposerDefaults: Effect.fn(
          "PersonalAccountService.updateComposerDefaults",
        )((principal, input) =>
          accounts.updateComposerDefaultsOwnedByUser(principal.userId, input),
        ),
        update: Effect.fn("PersonalAccountService.update")(
          function* (principal, input, requestId) {
            const current = yield* accounts.findOwnedByUser(principal.userId);
            const changedFields = [
              ...(current.displayName === input.displayName
                ? []
                : (["displayName"] as const)),
              ...(current.username === input.username
                ? []
                : (["username"] as const)),
            ];
            return yield* accounts
              .updateOwnedByUser(principal.userId, input)
              .pipe(
                Effect.tap(() =>
                  audit.record({
                    action: "personal_account.update",
                    scope: "personal",
                    outcome: "success",
                    requestId,
                    userId: principal.userId,
                    fields: changedFields,
                  }),
                ),
                Effect.tapError(() =>
                  audit.record({
                    action: "personal_account.update",
                    scope: "personal",
                    outcome: "rejected",
                    requestId,
                    userId: principal.userId,
                    fields: changedFields,
                  }),
                ),
              );
          },
        ),
        updateAppearance: Effect.fn("PersonalAccountService.updateAppearance")(
          function* (principal, input, requestId) {
            const current = yield* accounts.findOwnedByUser(principal.userId);
            const changedFields = [
              ...(input.appearance === undefined ||
              current.appearance === input.appearance
                ? []
                : (["appearance"] as const)),
              ...(input.palette === undefined ||
              current.palette === input.palette
                ? []
                : (["palette"] as const)),
              ...(input.terminalTheme === undefined ||
              current.terminalTheme === input.terminalTheme
                ? []
                : (["terminalTheme"] as const)),
            ];
            return yield* accounts
              .updateAppearanceOwnedByUser(principal.userId, input)
              .pipe(
                Effect.tap(() =>
                  audit.record({
                    action: "personal_appearance.update",
                    scope: "personal",
                    outcome: "success",
                    requestId,
                    userId: principal.userId,
                    fields: changedFields,
                  }),
                ),
                Effect.tapError(() =>
                  audit.record({
                    action: "personal_appearance.update",
                    scope: "personal",
                    outcome: "rejected",
                    requestId,
                    userId: principal.userId,
                    fields: changedFields,
                  }),
                ),
              );
          },
        ),
      });
    }),
  );
}
