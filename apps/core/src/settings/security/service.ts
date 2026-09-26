import {
  type BrowserSessionId,
  type BrowserSessionPage,
  type PersonalApiTokenId,
  type PersonalApiTokenScope,
  PersonalSecurityRepository,
  type PersonalSecurityRepositoryError,
  type Principal,
  type SecurityPageOffset,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SettingsAudit } from "../audit.js";

export class BrowserSessionNotFound extends Schema.TaggedError<BrowserSessionNotFound>()(
  "BrowserSessionNotFound",
  {},
) {}

export class CurrentBrowserSessionProtected extends Schema.TaggedError<CurrentBrowserSessionProtected>()(
  "CurrentBrowserSessionProtected",
  {},
) {}

interface PersonalSecurityServiceShape {
  readonly listSessions: (
    principal: Principal,
    sessionId: BrowserSessionId,
    limit: number,
    offset: SecurityPageOffset,
  ) => Effect.Effect<BrowserSessionPage, PersonalSecurityRepositoryError>;
  readonly ownedSessionForRevocation: (
    principal: Principal,
    currentSessionId: BrowserSessionId,
    targetSessionId: BrowserSessionId,
  ) => Effect.Effect<
    { readonly token: string },
    | PersonalSecurityRepositoryError
    | BrowserSessionNotFound
    | CurrentBrowserSessionProtected
  >;
  readonly auditMutation: (input: {
    readonly action: string;
    readonly outcome: "success" | "rejected";
    readonly principal: Principal;
    readonly requestId: string;
    readonly targetSessionId?: BrowserSessionId;
    readonly targetTokenId?: PersonalApiTokenId;
    readonly tokenScopes?: ReadonlyArray<PersonalApiTokenScope>;
  }) => Effect.Effect<void>;
}

export class PersonalSecurityService extends Context.Service<
  PersonalSecurityService,
  PersonalSecurityServiceShape
>()("@dx/core/settings/security/PersonalSecurityService") {
  static readonly layer = Layer.effect(
    PersonalSecurityService,
    Effect.gen(function* () {
      const repository = yield* PersonalSecurityRepository;
      const audit = yield* SettingsAudit;

      return PersonalSecurityService.of({
        listSessions: Effect.fn("PersonalSecurityService.listSessions")(
          function* (principal, sessionId, limit, offset) {
            const now = yield* DateTime.now;
            return yield* repository.listSessions(
              principal.userId,
              sessionId,
              limit,
              offset,
              DateTime.toEpochMillis(now),
            );
          },
        ),
        ownedSessionForRevocation: Effect.fn(
          "PersonalSecurityService.ownedSessionForRevocation",
        )(function* (principal, currentSessionId, targetSessionId) {
          const session = yield* repository.findOwnedSession(
            principal.userId,
            targetSessionId,
            currentSessionId,
          );
          if (Option.isNone(session))
            return yield* new BrowserSessionNotFound();
          if (session.value.isCurrent) {
            return yield* new CurrentBrowserSessionProtected();
          }
          return { token: session.value.token };
        }),
        auditMutation: Effect.fn("PersonalSecurityService.auditMutation")(
          function* (input) {
            yield* audit.record({
              action: input.action,
              scope: "personal",
              outcome: input.outcome,
              requestId: input.requestId,
              userId: input.principal.userId,
              ...(input.targetSessionId === undefined
                ? {}
                : { targetSessionId: input.targetSessionId }),
              ...(input.targetTokenId === undefined
                ? {}
                : { targetTokenId: input.targetTokenId }),
              ...(input.tokenScopes === undefined
                ? {}
                : { tokenScopes: input.tokenScopes }),
            });
          },
        ),
      });
    }),
  );
}
