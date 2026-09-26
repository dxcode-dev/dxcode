import { WorkspaceShortName } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export {
  type SettingsFieldError,
  SettingsFieldErrorSchema,
} from "./field-error.js";

import { SettingsFieldErrorSchema } from "./field-error.js";
import { WorkspaceProfileDataSchema } from "./workspace-profile.js";

export const GetWorkspaceSettingsContextParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceShortName,
});

export const SettingsWorkspaceDataSchema = WorkspaceProfileDataSchema;

export const PersonalSettingsContextDataSchema = Schema.Struct({
  activeScope: Schema.Literal("personal"),
  workspace: Schema.optional(SettingsWorkspaceDataSchema),
  dictationAvailable: Schema.optional(Schema.Boolean),
});

export const WorkspaceSettingsContextDataSchema = Schema.Struct({
  activeScope: Schema.Literal("workspace"),
  workspace: SettingsWorkspaceDataSchema,
  dictationAvailable: Schema.optional(Schema.Boolean),
});

export const SettingsContextDataSchema = Schema.Union([
  PersonalSettingsContextDataSchema,
  WorkspaceSettingsContextDataSchema,
]);

export const GetSettingsContextResponseSchema = successResponse(
  SettingsContextDataSchema,
);

export const GetSettingsContextInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_SETTINGS_SCOPE"),
    message: Schema.Literal("Settings scope validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const GetSettingsContextForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const GetSettingsContextPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Settings are temporarily unavailable.",
  );

export const GetSettingsContextErrorResponseSchema = Schema.Union([
  GetSettingsContextInvalidRequestResponseSchema,
  GetSettingsContextForbiddenResponseSchema,
  GetSettingsContextPersistenceUnavailableResponseSchema,
]);

export type SettingsWorkspaceData = typeof SettingsWorkspaceDataSchema.Type;
export type SettingsContextData = typeof SettingsContextDataSchema.Type;
export type GetSettingsContextResponse =
  typeof GetSettingsContextResponseSchema.Encoded;
export type GetSettingsContextInvalidRequestResponse =
  typeof GetSettingsContextInvalidRequestResponseSchema.Type;
export type GetSettingsContextForbiddenResponse =
  typeof GetSettingsContextForbiddenResponseSchema.Type;
