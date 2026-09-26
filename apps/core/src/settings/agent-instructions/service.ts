import {
  type PersistenceUnavailable,
  type PersonalAgentInstructions,
  type PersonalAgentInstructionsNotFound,
  PersonalAgentInstructionsRepository,
  type PersonalAgentInstructionsRevisionConflict,
  type Principal,
  type UpdatePersonalAgentInstructionsInput,
} from "@dx/domain";
import { Context, Effect, Layer, type Schema } from "effect";
import { SettingsAudit } from "../audit.js";

type PersonalAgentInstructionsReadError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | PersonalAgentInstructionsNotFound;

type PersonalAgentInstructionsUpdateError =
  | PersonalAgentInstructionsReadError
  | PersonalAgentInstructionsRevisionConflict;

interface PersonalAgentInstructionsServiceShape {
  readonly get: (
    principal: Principal,
  ) => Effect.Effect<
    PersonalAgentInstructions,
    PersonalAgentInstructionsReadError
  >;
  readonly update: (
    principal: Principal,
    input: UpdatePersonalAgentInstructionsInput,
    requestId: string,
  ) => Effect.Effect<
    PersonalAgentInstructions,
    PersonalAgentInstructionsUpdateError
  >;
}

export class PersonalAgentInstructionsService extends Context.Service<
  PersonalAgentInstructionsService,
  PersonalAgentInstructionsServiceShape
>()("@dx/core/settings/agent-instructions/PersonalAgentInstructionsService") {
  static readonly layer = Layer.effect(
    PersonalAgentInstructionsService,
    Effect.gen(function* () {
      const repository = yield* PersonalAgentInstructionsRepository;
      const audit = yield* SettingsAudit;

      return PersonalAgentInstructionsService.of({
        get: Effect.fn("PersonalAgentInstructionsService.get")((principal) =>
          repository.findOwnedByUser(principal.userId),
        ),
        update: Effect.fn("PersonalAgentInstructionsService.update")(
          (principal, input, requestId) =>
            repository.updateOwnedByUser(principal.userId, input).pipe(
              Effect.tap(() =>
                audit.record({
                  action: "personal_agent_instructions.update",
                  scope: "personal",
                  outcome: "success",
                  requestId,
                  userId: principal.userId,
                  fields: ["instructions"],
                }),
              ),
              Effect.tapError(() =>
                audit.record({
                  action: "personal_agent_instructions.update",
                  scope: "personal",
                  outcome: "rejected",
                  requestId,
                  userId: principal.userId,
                  fields: ["instructions"],
                }),
              ),
            ),
        ),
      });
    }),
  );
}
