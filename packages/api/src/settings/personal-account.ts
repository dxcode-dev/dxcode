import {
  PersonalAccountDisplayName,
  PersonalAccountEmail,
  PersonalAccountIdentityAuthority,
  PersonalAccountUsername,
  PersonalAppearance,
  PersonalPalette,
  PersonalTerminalTheme,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const PersonalAccountDataSchema = Schema.Struct({
  displayName: PersonalAccountDisplayName,
  username: PersonalAccountUsername,
  email: PersonalAccountEmail,
  emailVerified: Schema.Boolean,
  identityAuthority: PersonalAccountIdentityAuthority,
  threadCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  appearance: PersonalAppearance,
  palette: PersonalPalette,
  terminalTheme: PersonalTerminalTheme,
});

export const GetPersonalAccountResponseSchema = successResponse(
  PersonalAccountDataSchema,
);

export const UpdatePersonalAccountRequestSchema = Schema.Struct({
  displayName: Schema.String,
  username: Schema.String,
});

export const UpdatePersonalAccountResponseSchema = successResponse(
  PersonalAccountDataSchema,
);

export const UpdatePersonalAppearanceRequestSchema = Schema.Struct({
  appearance: Schema.optional(PersonalAppearance),
  palette: Schema.optional(PersonalPalette),
  terminalTheme: Schema.optional(PersonalTerminalTheme),
});

export const UpdatePersonalAppearanceResponseSchema = successResponse(
  PersonalAccountDataSchema,
);

export const PersonalAccountInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_ACCOUNT_PROFILE"),
    message: Schema.Literal("Account profile validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const PersonalAccountUsernameUnavailableResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("USERNAME_UNAVAILABLE"),
    message: Schema.Literal("That username is already in use."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const PersonalAccountForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const PersonalAccountNotFoundResponseSchema = errorResponse(
  "PERSONAL_ACCOUNT_NOT_FOUND",
  "Personal account not found.",
);

export const PersonalAccountPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Settings are temporarily unavailable.",
  );

export const PersonalAccountErrorResponseSchema = Schema.Union([
  PersonalAccountInvalidRequestResponseSchema,
  PersonalAccountUsernameUnavailableResponseSchema,
  PersonalAccountForbiddenResponseSchema,
  PersonalAccountNotFoundResponseSchema,
  PersonalAccountPersistenceUnavailableResponseSchema,
]);

export type PersonalAccountData = typeof PersonalAccountDataSchema.Type;
export type UpdatePersonalAccountRequest =
  typeof UpdatePersonalAccountRequestSchema.Type;
export type UpdatePersonalAppearanceRequest =
  typeof UpdatePersonalAppearanceRequestSchema.Type;
export type GetPersonalAccountResponse =
  typeof GetPersonalAccountResponseSchema.Encoded;
export type UpdatePersonalAccountResponse =
  typeof UpdatePersonalAccountResponseSchema.Encoded;
