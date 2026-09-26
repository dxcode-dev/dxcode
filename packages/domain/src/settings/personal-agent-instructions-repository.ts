import { Context, type Effect, type Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  PersonalAgentInstructionsNotFound,
  PersonalAgentInstructionsRevisionConflict,
} from "./errors.js";
import type {
  PersonalAgentInstructions,
  UpdatePersonalAgentInstructionsInput,
} from "./personal-agent-instructions.js";

export interface PersonalAgentInstructionsRepositoryShape {
  readonly findOwnedByUser: (
    userId: UserId,
  ) => Effect.Effect<
    PersonalAgentInstructions,
    | Schema.SchemaError
    | PersistenceUnavailable
    | PersonalAgentInstructionsNotFound
  >;
  readonly updateOwnedByUser: (
    userId: UserId,
    input: UpdatePersonalAgentInstructionsInput,
  ) => Effect.Effect<
    PersonalAgentInstructions,
    | Schema.SchemaError
    | PersistenceUnavailable
    | PersonalAgentInstructionsNotFound
    | PersonalAgentInstructionsRevisionConflict
  >;
}

export class PersonalAgentInstructionsRepository extends Context.Service<
  PersonalAgentInstructionsRepository,
  PersonalAgentInstructionsRepositoryShape
>()("@dx/domain/settings/PersonalAgentInstructionsRepository") {}
