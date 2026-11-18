import {
  type PersistenceUnavailable,
  type PersonalAccount,
  type PersonalAccountNotFound,
  PersonalAccountRepository,
  PersonalAccountUsernameChangeLocked,
  PersonalAccountUsernameReserved,
  type PersonalAccountUsernameUnavailable,
  type PersonalComposerDefaults,
  type Principal,
  personalAccountUsernameChoiceProblem,
  personalAccountUsernameNeedsPick,
  personalAppearanceFields,
  type UpdatePersonalAccountInput,
  type UpdatePersonalAppearanceInput,
  type UpdatePersonalComposerDefaultsInput,
  type UserId,
} from "@dx/domain";
import { Context, Effect, Layer, type Schema } from "effect";
import { SettingsAudit } from "../audit.js";

type PersonalAccountReadError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | PersonalAccountNotFound;

type PersonalAccountUpdateError =
  | PersonalAccountReadError
  | PersonalAccountUsernameChangeLocked
  | PersonalAccountUsernameReserved
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
  /**
   * A deployment admin gives a person their one username change back. The
   * caller has checked the admin; this records who did it.
   */
  readonly resetUsernameChange: (
    admin: Principal,
    userId: UserId,
    requestId: string,
  ) => Effect.Effect<PersonalAccount, PersonalAccountReadError>;
  readonly updateAppearance: (
    principal: Principal,
    input: UpdatePersonalAppearanceInput,
    requestId: string,
  ) => Effect.Effect<PersonalAccount, PersonalAccountReadError>;
  /** Account settings only: it reads every Thread the person owns. */
  readonly threadCount: (
    principal: Principal,
  ) => Effect.Effect<number, PersistenceUnavailable>;
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
        threadCount: Effect.fn("PersonalAccountService.threadCount")(
          (principal) => accounts.countThreadsOwnedByUser(principal.userId),
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
            const usernameChanges = current.username !== input.username;
            const changedFields = [
              ...(current.displayName === input.displayName
                ? []
                : (["displayName"] as const)),
              ...(usernameChanges ? (["username"] as const) : []),
            ];
            // A pick away from a placeholder or reserved name is free; any
            // other new username spends the one change.
            const freePick = personalAccountUsernameNeedsPick(current.username);
            const choiceProblem = usernameChanges
              ? personalAccountUsernameChoiceProblem(input.username)
              : undefined;
            const write = Effect.gen(function* () {
              if (choiceProblem !== undefined)
                return yield* new PersonalAccountUsernameReserved({
                  message: choiceProblem,
                });
              if (
                usernameChanges &&
                !freePick &&
                current.usernameChangedAt !== null
              )
                return yield* new PersonalAccountUsernameChangeLocked();
              return yield* accounts.updateOwnedByUser(
                principal.userId,
                input,
                {
                  expected: current.username,
                  usesChange: usernameChanges && !freePick,
                },
              );
            });
            return yield* write.pipe(
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
        resetUsernameChange: Effect.fn(
          "PersonalAccountService.resetUsernameChange",
        )((admin, userId, requestId) =>
          accounts.resetUsernameChange(userId).pipe(
            Effect.tap(() =>
              audit.record({
                action: "personal_account.username_change_reset",
                scope: "personal",
                outcome: "success",
                requestId,
                userId: admin.userId,
                targetUserId: userId,
                fields: ["username"],
              }),
            ),
            Effect.tapError(() =>
              audit.record({
                action: "personal_account.username_change_reset",
                scope: "personal",
                outcome: "rejected",
                requestId,
                userId: admin.userId,
                targetUserId: userId,
                fields: ["username"],
              }),
            ),
          ),
        ),
        updateAppearance: Effect.fn("PersonalAccountService.updateAppearance")(
          function* (principal, input, requestId) {
            const current = yield* accounts.findOwnedByUser(principal.userId);
            const changedFields = personalAppearanceFields.filter(
              (field) =>
                input[field] !== undefined && input[field] !== current[field],
            );
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
