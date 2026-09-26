import { Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { BrowserSessionId } from "./personal-security.js";

const identifier = (brand: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).pipe(
    Schema.brand(brand),
  );

export const PersonalModelSubscriptionConnectionId = identifier(
  "@dx/PersonalModelSubscriptionConnectionId",
);
export type PersonalModelSubscriptionConnectionId =
  typeof PersonalModelSubscriptionConnectionId.Type;

export const PersonalModelSubscriptionAuthorizationId = identifier(
  "@dx/PersonalModelSubscriptionAuthorizationId",
);
export type PersonalModelSubscriptionAuthorizationId =
  typeof PersonalModelSubscriptionAuthorizationId.Type;

export const ModelSubscriptionProviderId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
).pipe(Schema.brand("@dx/ModelSubscriptionProviderId"));
export type ModelSubscriptionProviderId =
  typeof ModelSubscriptionProviderId.Type;

export const GITHUB_COPILOT_SUBSCRIPTION_PROVIDER_ID = "github-copilot";

export const PersonalModelSubscriptionLifecycle = Schema.Literals([
  "connected",
  "needs-reauthorization",
]);

export const PersonalModelSubscriptionEntitlement = Schema.Struct({
  modelIds: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ).check(Schema.isMaxLength(100)),
  catalogRevision: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  observedAt: Timestamp,
  refreshAfter: Timestamp,
});

/** Public, owner-scoped metadata. Provider credentials are deliberately absent. */
export const PersonalModelSubscriptionConnection = Schema.Struct({
  id: PersonalModelSubscriptionConnectionId,
  ownerUserId: UserId,
  provider: ModelSubscriptionProviderId,
  providerAccountId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  providerAccountLogin: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  status: PersonalModelSubscriptionLifecycle,
  entitlement: PersonalModelSubscriptionEntitlement,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  connectedAt: Timestamp,
});
export type PersonalModelSubscriptionConnection =
  typeof PersonalModelSubscriptionConnection.Type;

/** Browser-visible device authorization state; the provider device code is private. */
export const PendingPersonalModelSubscriptionAuthorization = Schema.Struct({
  id: PersonalModelSubscriptionAuthorizationId,
  ownerUserId: UserId,
  browserSessionId: BrowserSessionId,
  provider: ModelSubscriptionProviderId,
  verificationUrl: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
  ),
  userCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  expiresAt: Timestamp,
  intervalSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  nextPollAt: Timestamp,
  state: Schema.Literal("pending"),
});
export type PendingPersonalModelSubscriptionAuthorization =
  typeof PendingPersonalModelSubscriptionAuthorization.Type;
