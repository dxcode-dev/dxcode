import { Schema } from "effect";

/**
 * Orb provider connections: a person or workspace connects their own
 * provider account (tasks/orb-provider-connections.md). Each provider
 * declares the fields its connection form asks for. dx verifies the values,
 * prepares the account (templates, images, the provider's own Worker), and
 * offers the provider's sizes once the connection is ready.
 */

export const OrbProviderFieldId = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9]{0,31}$/),
);

export type OrbProviderFieldId = typeof OrbProviderFieldId.Type;

/** One input on a provider's connection form. */
export const OrbProviderField = Schema.Struct({
  id: OrbProviderFieldId,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /** A secret is never returned and is entered as a password. */
  secret: Schema.Boolean,
  placeholder: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  /** One sentence under the field: where to find or create the value. */
  help: Schema.optional(Schema.String.check(Schema.isMaxLength(240))),
});

export type OrbProviderField = typeof OrbProviderField.Type;

export const MAX_ORB_PROVIDER_CREDENTIAL_LENGTH = 4_096;

const OrbProviderCredentialValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ORB_PROVIDER_CREDENTIAL_LENGTH),
  Schema.isPattern(/^\S+$/),
);

/** The values a connection form submits, by field ID. */
export const OrbProviderCredentials = Schema.Record(
  OrbProviderFieldId,
  OrbProviderCredentialValue,
).check(
  Schema.makeFilter(
    (credentials) =>
      Object.keys(credentials).length >= 1 &&
      Object.keys(credentials).length <= 16,
  ),
);

export type OrbProviderCredentials = typeof OrbProviderCredentials.Type;

/**
 * `preparing` while dx sets up the account (and again after a new Orb
 * recipe), `ready` once its sizes can start Threads, `failed` with an error
 * until the connection is saved again or retried.
 */
export const OrbProviderConnectionStatus = Schema.Literals([
  "preparing",
  "ready",
  "failed",
]);

export type OrbProviderConnectionStatus =
  typeof OrbProviderConnectionStatus.Type;

/** How far preparation is, for the settings page. */
export const OrbProviderPreparationProgress = Schema.Struct({
  /** What dx is doing now, as a short sentence. */
  step: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  done: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export type OrbProviderPreparationProgress =
  typeof OrbProviderPreparationProgress.Type;
