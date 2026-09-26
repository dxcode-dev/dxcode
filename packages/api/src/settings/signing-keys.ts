import {
  PersonalSigningKey,
  PersonalVerificationKey,
  SigningBackendCapability,
  SigningKeyId,
  VerificationKeyId,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const SigningKeySetupGuidanceSchema = Schema.Struct({
  title: Schema.String,
  steps: Schema.Array(Schema.String),
  gitHubUrl: Schema.String,
});

export type SigningKeySetupGuidance = typeof SigningKeySetupGuidanceSchema.Type;

export const SigningKeysDataSchema = Schema.Struct({
  capabilities: Schema.Array(SigningBackendCapability),
  managedKey: Schema.optional(PersonalSigningKey),
  verificationKeys: Schema.Array(PersonalVerificationKey),
});

export type SigningKeysData = typeof SigningKeysDataSchema.Type;

export const GetSigningKeysResponseSchema = successResponse(
  SigningKeysDataSchema,
);

export const ManagedSigningKeyMutationDataSchema = Schema.Struct({
  key: PersonalSigningKey,
  setup: SigningKeySetupGuidanceSchema,
});

export const CreateManagedSigningKeyResponseSchema = successResponse(
  ManagedSigningKeyMutationDataSchema,
);

export const RotateManagedSigningKeyResponseSchema =
  CreateManagedSigningKeyResponseSchema;

export const SigningKeyParamsSchema = Schema.Struct({
  signingKeyId: SigningKeyId,
});

export const RevokeManagedSigningKeyResponseSchema = successResponse(
  Schema.Struct({ revokedSigningKeyId: SigningKeyId }),
);

export const AddVerificationKeyRequestSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  publicKey: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
});

export const AddVerificationKeyResponseSchema = successResponse(
  PersonalVerificationKey,
);

export const VerificationKeyParamsSchema = Schema.Struct({
  verificationKeyId: VerificationKeyId,
});

export const RevokeVerificationKeyResponseSchema = successResponse(
  Schema.Struct({ revokedVerificationKeyId: VerificationKeyId }),
);

export const SigningKeysInvalidRequestResponseSchema = errorResponse(
  "INVALID_SIGNING_KEYS_REQUEST",
  "Signing key validation failed.",
);

export const SigningKeysForbiddenResponseSchema = errorResponse(
  "SIGNING_KEYS_FORBIDDEN",
  "Signing keys are unavailable for this user.",
);

export const SigningKeysBrowserSessionRequiredResponseSchema = errorResponse(
  "BROWSER_SESSION_REQUIRED",
  "A browser session is required to manage signing keys.",
);

export const SigningKeyNotFoundResponseSchema = errorResponse(
  "SIGNING_KEY_NOT_FOUND",
  "Signing key not found.",
);

export const SigningKeyConflictResponseSchema = errorResponse(
  "SIGNING_KEY_CONFLICT",
  "The signing key conflicts with an existing key.",
);

export const ManagedSigningUnavailableResponseSchema = errorResponse(
  "MANAGED_SIGNING_UNAVAILABLE",
  "Managed signing is not available in this deployment.",
);

export const SigningKeysUnavailableResponseSchema = errorResponse(
  "SIGNING_KEYS_UNAVAILABLE",
  "Signing keys are temporarily unavailable.",
);

export const SigningKeysErrorResponseSchema = Schema.Union([
  SigningKeysInvalidRequestResponseSchema,
  SigningKeysForbiddenResponseSchema,
  SigningKeysBrowserSessionRequiredResponseSchema,
  SigningKeyNotFoundResponseSchema,
  SigningKeyConflictResponseSchema,
  ManagedSigningUnavailableResponseSchema,
  SigningKeysUnavailableResponseSchema,
]);

export type AddVerificationKeyRequest =
  typeof AddVerificationKeyRequestSchema.Type;
