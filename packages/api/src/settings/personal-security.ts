import {
  BrowserSessionId,
  PersonalApiTokenId,
  PersonalApiTokenName,
  PersonalApiTokenPlaintext,
  PersonalApiTokenScopes,
  SecurityPageOffset,
} from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
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

/** Every security route answers its failures through one mapping in Core. */
const personalSecurityRefusals = [
  { status: 400, schema: PersonalSecurityInvalidRequestResponseSchema },
  { status: 403, schema: PersonalSecurityScopeForbiddenResponseSchema },
  { status: 403, schema: PersonalSecurityBrowserSessionRequiredResponseSchema },
  { status: 404, schema: PersonalApiTokenNotFoundResponseSchema },
  { status: 404, schema: BrowserSessionNotFoundResponseSchema },
  { status: 409, schema: CurrentBrowserSessionProtectedResponseSchema },
  { status: 503, schema: PersonalSecurityPersistenceUnavailableResponseSchema },
];

export const GetPersonalSecurityEndpoint = defineEndpoint({
  id: "settings.personalSecurity.get",
  summary: "Read security settings",
  method: "GET",
  path: "/v1/settings/personal/security",
  success: GetPersonalSecurityResponseSchema,
  refusals: personalSecurityRefusals,
});

export const ListPersonalApiTokensEndpoint = defineEndpoint({
  id: "settings.personalSecurity.tokens.list",
  summary: "List personal API tokens",
  method: "GET",
  path: "/v1/settings/personal/security/tokens",
  success: ListPersonalApiTokensResponseSchema,
  refusals: personalSecurityRefusals,
});

export const CreatePersonalApiTokenEndpoint = defineEndpoint({
  id: "settings.personalSecurity.tokens.create",
  summary: "Create a personal API token",
  method: "POST",
  path: "/v1/settings/personal/security/tokens",
  body: CreatePersonalApiTokenRequestSchema,
  success: CreatePersonalApiTokenResponseSchema,
  successStatus: 201,
  refusals: personalSecurityRefusals,
});

export const RotatePersonalApiTokenEndpoint = defineEndpoint({
  id: "settings.personalSecurity.tokens.rotate",
  summary: "Rotate a personal API token",
  method: "POST",
  path: "/v1/settings/personal/security/tokens/:tokenId/rotate",
  params: PersonalApiTokenParamsSchema,
  body: Schema.Struct({}),
  success: RotatePersonalApiTokenResponseSchema,
  refusals: personalSecurityRefusals,
});

export const RevokePersonalApiTokenEndpoint = defineEndpoint({
  id: "settings.personalSecurity.tokens.revoke",
  summary: "Revoke a personal API token",
  method: "DELETE",
  path: "/v1/settings/personal/security/tokens/:tokenId",
  params: PersonalApiTokenParamsSchema,
  success: RevokePersonalApiTokenResponseSchema,
  refusals: personalSecurityRefusals,
});

export const ListBrowserSessionsEndpoint = defineEndpoint({
  id: "settings.personalSecurity.sessions.list",
  summary: "List browser sessions",
  method: "GET",
  path: "/v1/settings/personal/security/sessions",
  query: ListBrowserSessionsQuerySchema,
  success: ListBrowserSessionsResponseSchema,
  refusals: personalSecurityRefusals,
});

export const RevokeBrowserSessionEndpoint = defineEndpoint({
  id: "settings.personalSecurity.sessions.revoke",
  summary: "Sign out a browser session",
  method: "DELETE",
  path: "/v1/settings/personal/security/sessions/:sessionId",
  params: BrowserSessionParamsSchema,
  success: RevokeBrowserSessionResponseSchema,
  refusals: personalSecurityRefusals,
});

export const RevokeOtherBrowserSessionsEndpoint = defineEndpoint({
  id: "settings.personalSecurity.sessions.revokeOthers",
  summary: "Sign out every other browser session",
  method: "POST",
  path: "/v1/settings/personal/security/sessions/revoke-others",
  body: Schema.Struct({}),
  success: RevokeOtherBrowserSessionsResponseSchema,
  refusals: personalSecurityRefusals,
});
