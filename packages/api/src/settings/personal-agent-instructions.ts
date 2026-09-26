import {
  PersonalAgentInstructionsContent,
  PersonalAgentInstructionsRevision,
  PersonalAgentInstructionsVersion,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const PersonalAgentInstructionsDataSchema = Schema.Struct({
  instructions: PersonalAgentInstructionsContent,
  revision: PersonalAgentInstructionsRevision,
  version: PersonalAgentInstructionsVersion,
  updatedAt: Timestamp,
});

export const GetPersonalAgentInstructionsResponseSchema = successResponse(
  PersonalAgentInstructionsDataSchema,
);

export const UpdatePersonalAgentInstructionsRequestSchema = Schema.Struct({
  instructions: Schema.String,
  expectedRevision: Schema.Number,
});

export const UpdatePersonalAgentInstructionsResponseSchema = successResponse(
  PersonalAgentInstructionsDataSchema,
);

export const PersonalAgentInstructionsInvalidRequestResponseSchema =
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal("INVALID_AGENT_INSTRUCTIONS"),
      message: Schema.Literal("Agent instructions validation failed."),
      requestId: Schema.String,
      fieldErrors: Schema.Array(SettingsFieldErrorSchema),
    }),
  });

export const PersonalAgentInstructionsConflictResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("AGENT_INSTRUCTIONS_REVISION_CONFLICT"),
    message: Schema.Literal(
      "Agent instructions changed in another session. Reload before saving.",
    ),
    requestId: Schema.String,
    currentRevision: PersonalAgentInstructionsRevision,
  }),
});

export const PersonalAgentInstructionsForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const PersonalAgentInstructionsNotFoundResponseSchema = errorResponse(
  "PERSONAL_AGENT_INSTRUCTIONS_NOT_FOUND",
  "Personal agent instructions were not found.",
);

export const PersonalAgentInstructionsPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Settings are temporarily unavailable.",
  );

export const PersonalAgentInstructionsErrorResponseSchema = Schema.Union([
  PersonalAgentInstructionsInvalidRequestResponseSchema,
  PersonalAgentInstructionsConflictResponseSchema,
  PersonalAgentInstructionsForbiddenResponseSchema,
  PersonalAgentInstructionsNotFoundResponseSchema,
  PersonalAgentInstructionsPersistenceUnavailableResponseSchema,
]);

export type PersonalAgentInstructionsData =
  typeof PersonalAgentInstructionsDataSchema.Type;
export type UpdatePersonalAgentInstructionsRequest =
  typeof UpdatePersonalAgentInstructionsRequestSchema.Type;
export type GetPersonalAgentInstructionsResponse =
  typeof GetPersonalAgentInstructionsResponseSchema.Encoded;
export type UpdatePersonalAgentInstructionsResponse =
  typeof UpdatePersonalAgentInstructionsResponseSchema.Encoded;
