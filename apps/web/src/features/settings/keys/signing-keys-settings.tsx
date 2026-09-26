import type { SigningKeySetupGuidance, SigningKeysData } from "@dx/api";
import type { PersonalSigningKey } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { securityErrorMessage } from "../security/security-queries.js";
import { SettingsHeading } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  ManagedSigningKeyCard,
  PublicSetupGuidance,
  SigningCapabilitiesCard,
  type SigningKeyConfirmation,
  SigningKeyDialogs,
  VerificationKeysCard,
} from "./signing-key-controls.js";
import {
  addVerificationKeyMutationOptions,
  createManagedSigningKeyMutationOptions,
  revokeManagedSigningKeyMutationOptions,
  revokeVerificationKeyMutationOptions,
  rotateManagedSigningKeyMutationOptions,
  signingKeysQueryOptions,
} from "./signing-keys-queries.js";

type SetupState = {
  readonly guidance: SigningKeySetupGuidance;
  readonly key: PersonalSigningKey;
};

export function SigningKeysSettings({
  onDirtyChange,
  settingsReturnTo,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const signingKeys = useQuery(signingKeysQueryOptions(identity.id));
  const createManaged = useMutation(
    createManagedSigningKeyMutationOptions(queryClient, identity.id),
  );
  const rotateManaged = useMutation(
    rotateManagedSigningKeyMutationOptions(queryClient, identity.id),
  );
  const revokeManaged = useMutation(
    revokeManagedSigningKeyMutationOptions(queryClient, identity.id),
  );
  const addVerification = useMutation(
    addVerificationKeyMutationOptions(queryClient, identity.id),
  );
  const revokeVerification = useMutation(
    revokeVerificationKeyMutationOptions(queryClient, identity.id),
  );
  const [name, setName] = React.useState("");
  const [publicKey, setPublicKey] = React.useState("");
  const [confirmation, setConfirmation] =
    React.useState<SigningKeyConfirmation>();
  const [setup, setSetup] = React.useState<SetupState>();
  const [error, setError] = React.useState<string>();
  const returnFocus = React.useRef<HTMLElement>(null);
  const pending =
    createManaged.isPending ||
    rotateManaged.isPending ||
    revokeManaged.isPending ||
    addVerification.isPending ||
    revokeVerification.isPending;

  const run = async (operation: () => Promise<unknown>) => {
    setError(undefined);
    try {
      return await operation();
    } catch (cause) {
      setError(securityErrorMessage(cause, "Signing key request failed."));
    }
  };

  const create = async () => {
    const result = await run(() => createManaged.mutateAsync(undefined));
    if (result !== undefined) {
      const mutation = result as Awaited<
        ReturnType<typeof createManaged.mutateAsync>
      >;
      setSetup({ guidance: mutation.setup, key: mutation.key });
    }
  };

  const confirm = async () => {
    if (confirmation === undefined) return;
    const selected = confirmation;
    const result = await run(() =>
      selected.kind === "rotate"
        ? rotateManaged.mutateAsync(selected.key.id)
        : selected.kind === "revoke-managed"
          ? revokeManaged.mutateAsync(selected.key.id)
          : revokeVerification.mutateAsync(selected.key.id),
    );
    if (result === undefined) return;
    if (selected.kind === "rotate") {
      const mutation = result as Awaited<
        ReturnType<typeof rotateManaged.mutateAsync>
      >;
      setSetup({ guidance: mutation.setup, key: mutation.key });
    }
    setConfirmation(undefined);
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await run(() =>
      addVerification.mutateAsync({ name, publicKey }),
    );
    if (result !== undefined) {
      setName("");
      setPublicKey("");
      onDirtyChange(false);
    }
  };

  const managedAvailable =
    signingKeys.data?.capabilities.some(
      (candidate) =>
        candidate.backend === "managed-ssh-ed25519" &&
        candidate.state === "available",
    ) ?? false;
  const openConfirmation = (
    selected: SigningKeyConfirmation,
    trigger: HTMLElement,
  ) => {
    returnFocus.current = trigger;
    setConfirmation(selected);
  };

  return (
    <div className="signing-keys-settings">
      <SettingsHeading
        title="Signing Keys"
        description="Sign dx-created commits and publish public keys without exposing private key material."
      />
      <SigningKeyLoadState query={signingKeys} />
      {signingKeys.data === undefined ? null : (
        <SigningCapabilitiesCard capabilities={signingKeys.data.capabilities} />
      )}
      {setup === undefined ? null : (
        <PublicSetupGuidance
          setup={setup.guidance}
          signingKey={setup.key}
          onDismiss={() => setSetup(undefined)}
        />
      )}
      <ManagedSigningKeyCard
        signingKey={signingKeys.data?.managedKey}
        available={managedAvailable}
        pending={pending}
        settingsReturnTo={settingsReturnTo}
        onCreate={() => void create()}
        onConfirm={openConfirmation}
      />
      <VerificationKeysCard
        keys={signingKeys.data?.verificationKeys ?? []}
        name={name}
        publicKey={publicKey}
        pending={pending}
        onName={(value) => {
          setName(value);
          onDirtyChange(true);
        }}
        onPublicKey={(value) => {
          setPublicKey(value);
          onDirtyChange(true);
        }}
        onAdd={(event) => void add(event)}
        onConfirm={openConfirmation}
      />
      {error === undefined ? null : (
        <p className="signing-key-error" role="alert">
          {error}
        </p>
      )}
      <SigningKeyDialogs
        confirmation={confirmation}
        pending={pending}
        finalFocus={returnFocus}
        onConfirmation={setConfirmation}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}

function SigningKeyLoadState({
  query,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly error: unknown;
    readonly data?: SigningKeysData;
    readonly refetch: () => Promise<unknown>;
  };
}) {
  if (query.isPending) {
    return (
      <div className="signing-key-state" aria-busy="true">
        <span className="tool-spinner" /> Loading signing keys…
      </div>
    );
  }
  if (query.error !== null) {
    return (
      <div className="signing-key-state" role="alert">
        {query.error instanceof Error
          ? query.error.message
          : "Signing keys could not be loaded."}
        <Button size="xs" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return null;
}
