import {
  ModelSubscriptionProviderId,
  PersonalModelSubscriptionAuthorizationId,
  PersonalModelSubscriptionConnectionId,
  PersonalModelSubscriptionLifecycle,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const PersonalModelSubscriptionConnectionDataSchema = Schema.Struct({
  id: PersonalModelSubscriptionConnectionId,
  provider: ModelSubscriptionProviderId,
  providerAccountLogin: Schema.String,
  status: PersonalModelSubscriptionLifecycle,
  modelIds: Schema.Array(Schema.String),
  catalogRevision: Schema.String,
  observedAt: Schema.DateTimeUtcFromString,
  refreshAfter: Schema.DateTimeUtcFromString,
  connectedAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

export const PendingPersonalModelSubscriptionAuthorizationDataSchema =
  Schema.Struct({
    id: PersonalModelSubscriptionAuthorizationId,
    provider: ModelSubscriptionProviderId,
    verificationUrl: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.DateTimeUtcFromString,
    intervalSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
    nextPollAt: Schema.DateTimeUtcFromString,
    state: Schema.Literal("pending"),
  });

export const ListPersonalModelSubscriptionsResponseSchema = successResponse(
  Schema.Struct({
    connections: Schema.Array(PersonalModelSubscriptionConnectionDataSchema),
  }),
);

export const BeginPersonalModelSubscriptionAuthorizationRequestSchema =
  Schema.Struct({ provider: ModelSubscriptionProviderId });
export const BeginPersonalModelSubscriptionAuthorizationResponseSchema =
  successResponse(PendingPersonalModelSubscriptionAuthorizationDataSchema);

export const PollPersonalModelSubscriptionAuthorizationRequestSchema =
  Schema.Struct({ authorizationId: PersonalModelSubscriptionAuthorizationId });
export const PollPersonalModelSubscriptionAuthorizationResponseSchema =
  successResponse(
    Schema.Union([
      PendingPersonalModelSubscriptionAuthorizationDataSchema,
      Schema.Struct({
        state: Schema.Literal("connected"),
        connection: PersonalModelSubscriptionConnectionDataSchema,
      }),
      Schema.Struct({ state: Schema.Literals(["denied", "expired"]) }),
    ]),
  );

export const RefreshPersonalModelSubscriptionRequestSchema = Schema.Struct({
  connectionId: PersonalModelSubscriptionConnectionId,
});
export const RefreshPersonalModelSubscriptionResponseSchema = successResponse(
  PersonalModelSubscriptionConnectionDataSchema,
);

export const DisconnectPersonalModelSubscriptionRequestSchema = Schema.Struct({
  connectionId: PersonalModelSubscriptionConnectionId,
});
export const DisconnectPersonalModelSubscriptionResponseSchema =
  successResponse(
    Schema.Struct({
      disconnectedConnectionId: PersonalModelSubscriptionConnectionId,
    }),
  );

export const PersonalModelSubscriptionNotFoundResponseSchema = errorResponse(
  "PERSONAL_MODEL_SUBSCRIPTION_NOT_FOUND",
  "Personal model subscription not found.",
);
export const PersonalModelSubscriptionBrowserSessionRequiredResponseSchema =
  errorResponse(
    "PERSONAL_MODEL_SUBSCRIPTION_BROWSER_SESSION_REQUIRED",
    "A browser session is required to change a personal model subscription.",
  );
export const PersonalModelSubscriptionInUseResponseSchema = errorResponse(
  "PERSONAL_MODEL_SUBSCRIPTION_IN_USE",
  "Remove this subscription from model routing before disconnecting it.",
);
export const PersonalModelSubscriptionUnavailableResponseSchema = errorResponse(
  "PERSONAL_MODEL_SUBSCRIPTION_UNAVAILABLE",
  "Personal model subscriptions are temporarily unavailable.",
);

export type ListPersonalModelSubscriptionsResponse =
  typeof ListPersonalModelSubscriptionsResponseSchema.Encoded;
export type BeginPersonalModelSubscriptionAuthorizationRequest =
  typeof BeginPersonalModelSubscriptionAuthorizationRequestSchema.Type;
export type BeginPersonalModelSubscriptionAuthorizationResponse =
  typeof BeginPersonalModelSubscriptionAuthorizationResponseSchema.Encoded;
export type PollPersonalModelSubscriptionAuthorizationResponse =
  typeof PollPersonalModelSubscriptionAuthorizationResponseSchema.Encoded;
