import {
  type PersonalSigningKey,
  PersonalVerificationKey,
  type Principal,
  type SigningBackendCapability,
  SigningKeyId,
  SigningKeyRepository,
  StoredPersonalSigningKey,
  type UserId,
  VerificationKeyId,
  type VerificationKeyName,
  type SigningPublicKey,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import { SettingsAudit } from "../audit.js";
import { encryptSigningPrivateKey } from "./encryption.js";
import {
  canonicalizeSigningPublicKey,
  generateManagedSshKey,
} from "./ssh-ed25519.js";

interface MutationAudit {
  readonly requestId: string;
  readonly userId: UserId;
}

interface SigningKeyServiceShape {
  readonly overview: (
    principal: Principal,
    capabilities: ReadonlyArray<SigningBackendCapability>,
  ) => Effect.Effect<
    {
      readonly capabilities: ReadonlyArray<SigningBackendCapability>;
      readonly managedKey?: PersonalSigningKey;
      readonly verificationKeys: ReadonlyArray<PersonalVerificationKey>;
    },
    unknown
  >;
  readonly createManaged: (
    keyring: ConfigEncryptionKeyring,
    principal: Principal,
    audit: MutationAudit,
  ) => Effect.Effect<PersonalSigningKey, unknown>;
  readonly rotateManaged: (
    keyring: ConfigEncryptionKeyring,
    principal: Principal,
    currentId: SigningKeyId,
    audit: MutationAudit,
  ) => Effect.Effect<PersonalSigningKey, unknown>;
  readonly revokeManaged: (
    principal: Principal,
    id: SigningKeyId,
    audit: MutationAudit,
  ) => Effect.Effect<void, unknown>;
  readonly addVerification: (
    principal: Principal,
    input: { readonly name: VerificationKeyName; readonly publicKey: string },
    audit: MutationAudit,
  ) => Effect.Effect<PersonalVerificationKey, unknown>;
  readonly revokeVerification: (
    principal: Principal,
    id: VerificationKeyId,
    audit: MutationAudit,
  ) => Effect.Effect<void, unknown>;
}

const publicKey = (stored: StoredPersonalSigningKey): PersonalSigningKey => ({
  id: stored.id,
  userId: stored.userId,
  backend: stored.backend,
  publicKey: stored.publicKey,
  fingerprint: stored.fingerprint,
  createdAt: stored.createdAt,
  rotatedAt: stored.rotatedAt,
});

const createStored = Effect.fn("SigningKeyService.createStored")(function* (
  keyring: ConfigEncryptionKeyring,
  userId: UserId,
) {
  const id = yield* Schema.decodeUnknownEffect(SigningKeyId)(
    `sig_${crypto.randomUUID()}`,
  );
  const generated = yield* generateManagedSshKey();
  const now = yield* DateTime.now;
  const context = {
    id,
    userId,
    publicKey: generated.publicKey,
    fingerprint: generated.fingerprint,
  };
  const envelope = yield* encryptSigningPrivateKey(
    keyring,
    context,
    generated.privateKey,
  );
  return yield* Schema.decodeUnknownEffect(
    Schema.toType(StoredPersonalSigningKey),
  )({
    ...context,
    backend: "managed-ssh-ed25519",
    privateKeyReference: { version: 1, kind: "signing-private-key", id },
    privateKeyEnvelope: envelope,
    createdAt: now,
    rotatedAt: now,
  });
});

export class SigningKeyService extends Context.Service<
  SigningKeyService,
  SigningKeyServiceShape
>()("@dx/core/settings/keys/SigningKeyService") {
  static readonly layer = Layer.effect(
    SigningKeyService,
    Effect.gen(function* () {
      const repository = yield* SigningKeyRepository;
      const audit = yield* SettingsAudit;

      const record = (
        action: string,
        details: MutationAudit & {
          readonly signingKeyId?: SigningKeyId;
          readonly verificationKeyId?: VerificationKeyId;
        },
      ) =>
        audit.record({
          action,
          scope: "personal",
          outcome: "success",
          requestId: details.requestId,
          userId: details.userId,
          ...(details.signingKeyId === undefined
            ? {}
            : { signingKeyId: details.signingKeyId }),
          ...(details.verificationKeyId === undefined
            ? {}
            : { verificationKeyId: details.verificationKeyId }),
        });

      return SigningKeyService.of({
        overview: Effect.fn("SigningKeyService.overview")(
          function* (principal, capabilities) {
            const managed = yield* repository.findActiveManaged(
              principal.userId,
            );
            const verificationKeys = yield* repository.listVerification(
              principal.userId,
            );
            return {
              capabilities,
              ...(managed === undefined
                ? {}
                : { managedKey: publicKey(managed) }),
              verificationKeys,
            };
          },
        ),
        createManaged: Effect.fn("SigningKeyService.createManaged")(
          function* (keyring, principal, mutationAudit) {
            const stored = yield* createStored(keyring, principal.userId);
            yield* repository.insertManaged(stored);
            yield* record("signing_key.managed.create", {
              ...mutationAudit,
              signingKeyId: stored.id,
            });
            return publicKey(stored);
          },
        ),
        rotateManaged: Effect.fn("SigningKeyService.rotateManaged")(
          function* (keyring, principal, currentId, mutationAudit) {
            const replacement = yield* createStored(keyring, principal.userId);
            const now = yield* DateTime.now;
            yield* repository.rotateManaged(
              principal.userId,
              currentId,
              replacement,
              now,
            );
            yield* record("signing_key.managed.rotate", {
              ...mutationAudit,
              signingKeyId: replacement.id,
            });
            return publicKey(replacement);
          },
        ),
        revokeManaged: Effect.fn("SigningKeyService.revokeManaged")(
          function* (principal, id, mutationAudit) {
            const now = yield* DateTime.now;
            yield* repository.revokeManaged(principal.userId, id, now);
            yield* record("signing_key.managed.revoke", {
              ...mutationAudit,
              signingKeyId: id,
            });
          },
        ),
        addVerification: Effect.fn("SigningKeyService.addVerification")(
          function* (principal, input, mutationAudit) {
            const canonical = yield* canonicalizeSigningPublicKey(
              input.publicKey,
            );
            const id = yield* Schema.decodeUnknownEffect(VerificationKeyId)(
              `vrf_${crypto.randomUUID()}`,
            );
            const now = yield* DateTime.now;
            const key = yield* Schema.decodeUnknownEffect(
              Schema.toType(PersonalVerificationKey),
            )({
              id,
              userId: principal.userId,
              name: input.name,
              publicKey: canonical.publicKey satisfies SigningPublicKey,
              fingerprint: canonical.fingerprint,
              createdAt: now,
            });
            yield* repository.insertVerification(key);
            yield* record("signing_key.verification.add", {
              ...mutationAudit,
              verificationKeyId: id,
            });
            return key;
          },
        ),
        revokeVerification: Effect.fn("SigningKeyService.revokeVerification")(
          function* (principal, id, mutationAudit) {
            const now = yield* DateTime.now;
            yield* repository.revokeVerification(principal.userId, id, now);
            yield* record("signing_key.verification.revoke", {
              ...mutationAudit,
              verificationKeyId: id,
            });
          },
        ),
      });
    }),
  );
}
