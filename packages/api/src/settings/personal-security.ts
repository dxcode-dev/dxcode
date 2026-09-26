import {
  BrowserSessionId,
  PersonalApiTokenId,
  PersonalApiTokenName,
  PersonalApiTokenPlaintext,
  PersonalApiTokenScopes,
  SecurityPageOffset,
} from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const PersonalApiTokenDataSchema = Schema.Struct({
  id: PersonalApiTokenId,
  name: PersonalApiTokenName,
  identifier: Schema.String,
  scopes: PersonalApiTokenScopes,
  createdAt: Schema.DateTimeUtcFromString,
  lastUsedAt: Schema.optional(Schema.DateTimeUtcFromString),
});

export const BrowserSessionDataSchema = Schema.Struct({
  id: BrowserSessionId,
  device: Schema.String,
  network: Schema.String,
  isCurrent: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  lastActiveAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});

export const GetPersonalSecurityResponseSchema = successResponse(
  Schema.Struct({
    passkeys: Schema.Struct({
      available: Schema.Literal(false),
      reason: Schema.Literal(
        "Passkeys are unavailable until the Better Auth WebAuthn plugin and a deterministic Worker ceremony are configured.",
      ),
    }),
  }),
);

export const ListPersonalApiTokensResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(PersonalApiTokenDataSchema) }),
);

export const CreatePersonalApiTokenRequestSchema = Schema.Struct({
  name: Schema.String,
  scopes: Schema.Array(Schema.String),
});

export const PersonalApiTokenSecretDataSchema = Schema.Struct({
  token: PersonalApiTokenDataSchema,
  plaintext: PersonalApiTokenPlaintext,
});

export const CreatePersonalApiTokenResponseSchema = successResponse(
  PersonalApiTokenSecretDataSchema,
);

export const PersonalApiTokenParamsSchema = Schema.Struct({
  tokenId: PersonalApiTokenId,
});

export const RotatePersonalApiTokenResponseSchema = successResponse(
  PersonalApiTokenSecretDataSchema,
);

export const RevokePersonalApiTokenResponseSchema = successResponse(
  Schema.Struct({ revokedTokenId: PersonalApiTokenId }),
);

const SecurityPageOffsetQuerySchema = Schema.String.check(
  Schema.isPattern(/^[0-9]+$/),
).pipe(
  Schema.decodeTo(Schema.FiniteFromString),
  Schema.decodeTo(SecurityPageOffset),
);

export const ListBrowserSessionsQuerySchema = Schema.Struct({
  limit: Schema.optional(PageLimitQuerySchema),
  offset: Schema.optional(SecurityPageOffsetQuerySchema),
});

export const ListBrowserSessionsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(BrowserSessionDataSchema),
    nextOffset: Schema.optional(SecurityPageOffset),
  }),
);

export const BrowserSessionParamsSchema = Schema.Struct({
  sessionId: BrowserSessionId,
});

export const RevokeBrowserSessionResponseSchema = successResponse(
  Schema.Struct({ revokedSessionId: BrowserSessionId }),
);

export const RevokeOtherBrowserSessionsResponseSchema = successResponse(
  Schema.Struct({ currentSessionProtected: Schema.Literal(true) }),
);

export const PersonalSecurityInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_SECURITY_REQUEST"),
    message: Schema.Literal("Security request validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const PersonalSecurityScopeForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const PersonalSecurityBrowserSessionRequiredResponseSchema =
  errorResponse(
    "BROWSER_SESSION_REQUIRED",
    "A browser session is required to manage security settings.",
  );

export const PersonalApiTokenNotFoundResponseSchema = errorResponse(
  "PERSONAL_API_TOKEN_NOT_FOUND",
  "Personal API token not found.",
);

export const BrowserSessionNotFoundResponseSchema = errorResponse(
  "BROWSER_SESSION_NOT_FOUND",
  "Browser session not found.",
);

export const CurrentBrowserSessionProtectedResponseSchema = errorResponse(
  "CURRENT_SESSION_PROTECTED",
  "The current browser session cannot be revoked from this control.",
);

export const PersonalSecurityPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Security settings are temporarily unavailable.",
  );

export const PersonalSecurityErrorResponseSchema = Schema.Union([
  PersonalSecurityInvalidRequestResponseSchema,
  PersonalSecurityScopeForbiddenResponseSchema,
  PersonalSecurityBrowserSessionRequiredResponseSchema,
  PersonalApiTokenNotFoundResponseSchema,
  BrowserSessionNotFoundResponseSchema,
  CurrentBrowserSessionProtectedResponseSchema,
  PersonalSecurityPersistenceUnavailableResponseSchema,
]);

export type PersonalApiTokenData = typeof PersonalApiTokenDataSchema.Type;
export type BrowserSessionData = typeof BrowserSessionDataSchema.Type;
export type PersonalSecurityData =
  typeof GetPersonalSecurityResponseSchema.Type.data;
export type PersonalApiTokenSecretData =
  typeof PersonalApiTokenSecretDataSchema.Type;
export type CreatePersonalApiTokenRequest =
  typeof CreatePersonalApiTokenRequestSchema.Type;
export type BrowserSessionPageData =
  typeof ListBrowserSessionsResponseSchema.Type.data;
