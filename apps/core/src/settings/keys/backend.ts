import type { SigningBackendCapability, SigningBackendKind } from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  ConfigEncryptionUnavailable,
  loadConfigEncryptionKeyring,
} from "../config-encryption.js";

export class ManagedSigningUnavailable extends Schema.TaggedError<ManagedSigningUnavailable>()(
  "ManagedSigningUnavailable",
  {},
) {}

export const isManagedSigningEnabled = (bindings: Bindings): boolean =>
  bindings.DX_MANAGED_SSH_SIGNING_ENABLED === "true";

export interface SigningBackend {
  readonly kind: SigningBackendKind;
  readonly capability: (
    bindings: Bindings,
  ) => Effect.Effect<SigningBackendCapability>;
}

const unavailableRunnerBackend = (
  kind: Exclude<SigningBackendKind, "managed-ssh-ed25519">,
): SigningBackend => ({
  kind,
  capability: () =>
    Effect.succeed({
      backend: kind,
      state: "unavailable",
      source: "runner",
      reason: "runner-not-supplied",
    }),
});

const managedBackend: SigningBackend = {
  kind: "managed-ssh-ed25519",
  capability: (bindings) => {
    if (!isManagedSigningEnabled(bindings)) {
      return Effect.succeed({
        backend: "managed-ssh-ed25519",
        state: "unavailable",
        source: "deployment",
        reason: "operator-disabled",
      });
    }
    return Effect.option(loadConfigEncryptionKeyring(bindings)).pipe(
      Effect.map((keyring) =>
        Option.isSome(keyring)
          ? {
              backend: "managed-ssh-ed25519" as const,
              state: "available" as const,
              source: "deployment" as const,
              reason: "available" as const,
            }
          : {
              backend: "managed-ssh-ed25519" as const,
              state: "unavailable" as const,
              source: "deployment" as const,
              reason: "encryption-unavailable" as const,
            },
      ),
    );
  },
};

export const signingBackends: ReadonlyArray<SigningBackend> = [
  unavailableRunnerBackend("runner-ssh-agent"),
  unavailableRunnerBackend("runner-gpg-agent"),
  unavailableRunnerBackend("hardware"),
  managedBackend,
];

export const preferredSigningBackend = (
  capabilities: ReadonlyArray<SigningBackendCapability>,
): SigningBackendCapability | undefined =>
  signingBackends
    .map(({ kind }) =>
      capabilities.find(
        ({ backend, state }) => backend === kind && state === "available",
      ),
    )
    .find((capability) => capability !== undefined);

export const signingBackendCapabilities = Effect.fn(
  "signingBackendCapabilities",
)((bindings: Bindings) =>
  Effect.all(signingBackends.map((backend) => backend.capability(bindings))),
);

export const requireManagedSigning = Effect.fn("requireManagedSigning")(
  function* (bindings: Bindings) {
    if (!isManagedSigningEnabled(bindings)) {
      return yield* new ManagedSigningUnavailable();
    }
    return yield* loadConfigEncryptionKeyring(bindings).pipe(
      Effect.mapError((failure) =>
        failure instanceof ConfigEncryptionUnavailable
          ? new ManagedSigningUnavailable()
          : failure,
      ),
    );
  },
);
