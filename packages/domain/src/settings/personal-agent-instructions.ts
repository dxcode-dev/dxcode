import { Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";

export const MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH = 10_000;
export const PERSONAL_AGENT_INSTRUCTIONS_VERSION = 1 as const;

export const PersonalAgentInstructionsContent = Schema.String.check(
  Schema.isMaxLength(MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH),
).pipe(Schema.brand("@dx/PersonalAgentInstructionsContent"));

export type PersonalAgentInstructionsContent =
  typeof PersonalAgentInstructionsContent.Type;

export const PersonalAgentInstructionsRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("@dx/PersonalAgentInstructionsRevision"));

export type PersonalAgentInstructionsRevision =
  typeof PersonalAgentInstructionsRevision.Type;

export const PersonalAgentInstructionsVersion = Schema.Literal(
  PERSONAL_AGENT_INSTRUCTIONS_VERSION,
);

export type PersonalAgentInstructionsVersion =
  typeof PersonalAgentInstructionsVersion.Type;

export const PersonalAgentInstructions = Schema.Struct({
  userId: UserId,
  content: PersonalAgentInstructionsContent,
  revision: PersonalAgentInstructionsRevision,
  version: PersonalAgentInstructionsVersion,
  updatedAt: Timestamp,
});

export type PersonalAgentInstructions = typeof PersonalAgentInstructions.Type;

export const UpdatePersonalAgentInstructionsInput = Schema.Struct({
  content: PersonalAgentInstructionsContent,
  expectedRevision: PersonalAgentInstructionsRevision,
});

export type UpdatePersonalAgentInstructionsInput =
  typeof UpdatePersonalAgentInstructionsInput.Type;

export const PersonalAgentInstructionsSnapshot = Schema.Struct({
  content: PersonalAgentInstructionsContent,
  revision: PersonalAgentInstructionsRevision,
  version: PersonalAgentInstructionsVersion,
});

export type PersonalAgentInstructionsSnapshot =
  typeof PersonalAgentInstructionsSnapshot.Type;

export const normalizePersonalAgentInstructions = (value: string): string =>
  value.replace(/\r\n?/g, "\n");
