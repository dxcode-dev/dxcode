import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { RunnerAdapterKind, RunnerProfileId } from "./runner-profile.js";

export const SigningBackendKind = Schema.Literals([
  "runner-ssh-agent",
  "runner-gpg-agent",
  "hardware",
  "managed-ssh-ed25519",
]);

export type SigningBackendKind = typeof SigningBackendKind.Type;

export const SigningBackendCapabilityState = Schema.Literals([
  "available",
  "unavailable",
]);

export const SigningBackendCapabilityReason = Schema.Literals([
  "runner-not-supplied",
  "operator-disabled",
  "encryption-unavailable",
  "available",
]);

export const SigningBackendCapability = Schema.Struct({
  backend: SigningBackendKind,
  state: SigningBackendCapabilityState,
  source: Schema.Literals(["runner", "deployment"]),
  reason: SigningBackendCapabilityReason,
});

export type SigningBackendCapability = typeof SigningBackendCapability.Type;

export const SigningKeyId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/SigningKeyId"));

export type SigningKeyId = typeof SigningKeyId.Type;

export const VerificationKeyId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/VerificationKeyId"));

export type VerificationKeyId = typeof VerificationKeyId.Type;

export const VerificationKeyName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
).pipe(Schema.brand("@dx/VerificationKeyName"));

export type VerificationKeyName = typeof VerificationKeyName.Type;

export const normalizeVerificationKeyName = (value: string): string =>
  value.trim();

export const SigningPublicKey = Schema.String.check(
  Schema.isMinLength(50),
  Schema.isMaxLength(256),
  Schema.isPattern(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/),
).pipe(Schema.brand("@dx/SigningPublicKey"));

export type SigningPublicKey = typeof SigningPublicKey.Type;

export const SigningKeyFingerprint = Schema.String.check(
  Schema.isPattern(/^SHA256:[A-Za-z0-9+/]{43}$/),
).pipe(Schema.brand("@dx/SigningKeyFingerprint"));

export type SigningKeyFingerprint = typeof SigningKeyFingerprint.Type;

export const SigningPrivateKeyPlaintext = Schema.String.check(
  Schema.isMinLength(100),
  Schema.isMaxLength(4_096),
  Schema.isPattern(
    /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/,
  ),
).pipe(Schema.brand("@dx/SigningPrivateKeyPlaintext"));

export type SigningPrivateKeyPlaintext = typeof SigningPrivateKeyPlaintext.Type;

const Base64 = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(16_384),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
);

export const SigningPrivateKeyEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  keyVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  valueNonce: Base64,
  ciphertext: Base64,
  wrappedKeyNonce: Base64,
  wrappedKey: Base64,
});

export type SigningPrivateKeyEnvelope = typeof SigningPrivateKeyEnvelope.Type;

export const SigningPrivateKeyReference = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("signing-private-key"),
  id: SigningKeyId,
});

export type SigningPrivateKeyReference = typeof SigningPrivateKeyReference.Type;

export const PersonalSigningKey = Schema.Struct({
  id: SigningKeyId,
  userId: UserId,
  backend: Schema.Literal("managed-ssh-ed25519"),
  publicKey: SigningPublicKey,
  fingerprint: SigningKeyFingerprint,
  createdAt: Timestamp,
  rotatedAt: Timestamp,
});

export type PersonalSigningKey = typeof PersonalSigningKey.Type;

export const StoredPersonalSigningKey = Schema.Struct({
  ...PersonalSigningKey.fields,
  privateKeyReference: SigningPrivateKeyReference,
  privateKeyEnvelope: SigningPrivateKeyEnvelope,
});

export type StoredPersonalSigningKey = typeof StoredPersonalSigningKey.Type;

export const PersonalVerificationKey = Schema.Struct({
  id: VerificationKeyId,
  userId: UserId,
  name: VerificationKeyName,
  publicKey: SigningPublicKey,
  fingerprint: SigningKeyFingerprint,
  createdAt: Timestamp,
});

export type PersonalVerificationKey = typeof PersonalVerificationKey.Type;

export class SigningKeyNotFound extends Schema.TaggedError<SigningKeyNotFound>()(
  "SigningKeyNotFound",
  {},
) {}

export class SigningKeyConflict extends Schema.TaggedError<SigningKeyConflict>()(
  "SigningKeyConflict",
  {},
) {}

export interface SigningKeyRepositoryShape {
  readonly findActiveManaged: (
    userId: UserId,
  ) => Effect.Effect<
    StoredPersonalSigningKey | undefined,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly insertManaged: (
    key: StoredPersonalSigningKey,
  ) => Effect.Effect<
    void,
    PersistenceUnavailable | Schema.SchemaError | SigningKeyConflict
  >;
  readonly rotateManaged: (
    userId: UserId,
    currentId: SigningKeyId,
    replacement: StoredPersonalSigningKey,
    revokedAt: Timestamp,
  ) => Effect.Effect<
    void,
    | PersistenceUnavailable
    | Schema.SchemaError
    | SigningKeyNotFound
    | SigningKeyConflict
  >;
  readonly revokeManaged: (
    userId: UserId,
    id: SigningKeyId,
    revokedAt: Timestamp,
  ) => Effect.Effect<void, PersistenceUnavailable | SigningKeyNotFound>;
  readonly listVerification: (
    userId: UserId,
  ) => Effect.Effect<
    ReadonlyArray<PersonalVerificationKey>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly insertVerification: (
    key: PersonalVerificationKey,
  ) => Effect.Effect<void, PersistenceUnavailable | SigningKeyConflict>;
  readonly revokeVerification: (
    userId: UserId,
    id: VerificationKeyId,
    revokedAt: Timestamp,
  ) => Effect.Effect<void, PersistenceUnavailable | SigningKeyNotFound>;
}

export class SigningKeyRepository extends Context.Service<
  SigningKeyRepository,
  SigningKeyRepositoryShape
>()("@dx/domain/settings/SigningKeyRepository") {}

export const GitCommitSigningStatus = Schema.Literals([
  "disabled",
  "unsigned",
  "verified",
  "failed",
]);

export const GitCommitSigningFailure = Schema.Literals([
  "backend-unavailable",
  "signing-failed",
  "verification-failed",
]);

export const GitCommitSigningAttribution = Schema.Struct({
  policy: Schema.Literals(["disabled", "preferred", "required"]),
  status: GitCommitSigningStatus,
  backend: Schema.NullOr(SigningBackendKind),
  runnerProfileId: RunnerProfileId,
  runnerProfileVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runnerAdapter: RunnerAdapterKind,
  fingerprint: Schema.optional(SigningKeyFingerprint),
  failure: Schema.optional(GitCommitSigningFailure),
});

export type GitCommitSigningAttribution =
  typeof GitCommitSigningAttribution.Type;

export const GitCommitExecutionResult = Schema.Struct({
  outcome: Schema.Literals(["committed", "failed"]),
  commitSha: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  ),
  signing: GitCommitSigningAttribution,
});

export type GitCommitExecutionResult = typeof GitCommitExecutionResult.Type;
