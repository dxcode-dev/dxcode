import type { SigningKeySetupGuidance } from "@dx/api";
import type {
  PersonalSigningKey,
  PersonalVerificationKey,
  SigningBackendCapability,
} from "@dx/domain";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ClipboardCopy,
  KeyRound,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { settingsNavigationState } from "../../../shared/navigation/settings-return.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsCard, SettingsRow } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";

export type SigningKeyConfirmation =
  | { readonly kind: "rotate"; readonly key: PersonalSigningKey }
  | { readonly kind: "revoke-managed"; readonly key: PersonalSigningKey }
  | {
      readonly kind: "revoke-verification";
      readonly key: PersonalVerificationKey;
    };

const backendLabels: Record<SigningBackendCapability["backend"], string> = {
  "runner-ssh-agent": "Runner SSH agent",
  "runner-gpg-agent": "Runner GPG agent",
  hardware: "Hardware-backed delegation",
  "managed-ssh-ed25519": "dx-managed SSH Ed25519",
};

export function SigningCapabilitiesCard({
  capabilities,
}: {
  readonly capabilities: ReadonlyArray<SigningBackendCapability>;
}) {
  return (
    <SettingsCard title="Signing backends">
      {capabilities.map((capability) => (
        <SettingsRow
          key={capability.backend}
          title={backendLabels[capability.backend]}
          description={
            capability.state === "available"
              ? capability.source === "runner"
                ? "Supplied by the selected deployment runner profile."
                : "Enabled by this deployment with encrypted private-key storage."
              : capability.reason === "runner-not-supplied"
                ? "This runner does not supply the required agent or hardware delegation."
                : capability.reason === "operator-disabled"
                  ? "Not enabled by the deployment operator."
                  : "The deployment encryption boundary is unavailable."
          }
          badge={
            <Badge data-state={capability.state}>
              {capability.state === "available" ? "Available" : "Unavailable"}
            </Badge>
          }
        />
      ))}
    </SettingsCard>
  );
}

export function PublicSetupGuidance({
  setup,
  signingKey,
  onDismiss,
}: {
  readonly setup: SigningKeySetupGuidance;
  readonly signingKey: PersonalSigningKey;
  readonly onDismiss: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <SettingsCard title={setup.title}>
      <div className="signing-key-setup" role="status">
        <p>This public-only guidance is shown after generation or rotation.</p>
        <code>{signingKey.publicKey}</code>
        <strong>{signingKey.fingerprint}</strong>
        <ol>
          {setup.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(signingKey.publicKey)
                .then(() => setCopied(true))
            }
          >
            {copied ? (
              <Check aria-hidden="true" />
            ) : (
              <ClipboardCopy aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy public key"}
          </Button>
          <a href={setup.gitHubUrl} target="_blank" rel="noreferrer">
            Open GitHub SSH settings
          </a>
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

export function ManagedSigningKeyCard({
  signingKey,
  available,
  pending,
  settingsReturnTo,
  onCreate,
  onConfirm,
}: {
  readonly signingKey?: PersonalSigningKey;
  readonly available: boolean;
  readonly pending: boolean;
  readonly settingsReturnTo?: SettingsSectionProps["settingsReturnTo"];
  readonly onCreate: () => void;
  readonly onConfirm: (
    confirmation: SigningKeyConfirmation,
    trigger: HTMLElement,
  ) => void;
}) {
  return (
    <SettingsCard title="Managed signing key">
      {signingKey === undefined ? (
        <SettingsRow
          title="No managed key"
          description="Create an Ed25519 key server-side. Only its public key and fingerprint are returned."
          control={
            <Button
              size="xs"
              disabled={!available || pending}
              onClick={onCreate}
            >
              <KeyRound aria-hidden="true" /> Generate key
            </Button>
          }
        />
      ) : (
        <SettingsRow
          title={signingKey.fingerprint}
          description={<code>{signingKey.publicKey}</code>}
          badge={<Badge data-state="available">Active</Badge>}
          control={
            <div className="signing-key-actions">
              <Button
                size="xs"
                variant="outline"
                onClick={(event) =>
                  onConfirm(
                    { kind: "rotate", key: signingKey },
                    event.currentTarget,
                  )
                }
              >
                <RefreshCw aria-hidden="true" /> Rotate
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={(event) =>
                  onConfirm(
                    { kind: "revoke-managed", key: signingKey },
                    event.currentTarget,
                  )
                }
              >
                <Trash2 aria-hidden="true" /> Revoke
              </Button>
            </div>
          }
        />
      )}
      <SettingsRow
        title="Project signing policy"
        description="Require, prefer, or disable signing when new projects snapshot their defaults."
        badge={<Badge>Project default</Badge>}
        control={
          <Link
            className="signing-key-policy-link"
            to="/settings/$section"
            params={{ section: "projects" }}
            state={settingsNavigationState(settingsReturnTo)}
          >
            Configure
          </Link>
        }
      />
    </SettingsCard>
  );
}

export function VerificationKeysCard({
  keys,
  name,
  publicKey,
  pending,
  onName,
  onPublicKey,
  onAdd,
  onConfirm,
}: {
  readonly keys: ReadonlyArray<PersonalVerificationKey>;
  readonly name: string;
  readonly publicKey: string;
  readonly pending: boolean;
  readonly onName: (value: string) => void;
  readonly onPublicKey: (value: string) => void;
  readonly onAdd: (event: React.FormEvent) => void;
  readonly onConfirm: (
    confirmation: SigningKeyConfirmation,
    trigger: HTMLElement,
  ) => void;
}) {
  const nameId = React.useId();
  const publicKeyId = React.useId();
  return (
    <SettingsCard title="Verification public keys">
      <form className="signing-key-form" onSubmit={onAdd}>
        <label htmlFor={nameId}>
          Name
          <Input
            id={nameId}
            value={name}
            maxLength={64}
            required
            onChange={(event) => onName(event.target.value)}
            placeholder="Work laptop"
          />
        </label>
        <label htmlFor={publicKeyId}>
          SSH Ed25519 public key
          <Input
            id={publicKeyId}
            value={publicKey}
            maxLength={512}
            required
            onChange={(event) => onPublicKey(event.target.value)}
            placeholder="ssh-ed25519 AAAA…"
          />
        </label>
        <Button type="submit" size="xs" disabled={pending}>
          Add public key
        </Button>
      </form>
      {keys.map((key) => (
        <SettingsRow
          key={key.id}
          title={key.name}
          description={
            <>
              <code>{key.fingerprint}</code>
              <span>{key.publicKey}</span>
            </>
          }
          badge={<Badge>Verification</Badge>}
          control={
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Revoke ${key.name}`}
              onClick={(event) =>
                onConfirm(
                  { kind: "revoke-verification", key },
                  event.currentTarget,
                )
              }
            >
              <Trash2 aria-hidden="true" /> Revoke
            </Button>
          }
        />
      ))}
      {keys.length === 0 ? (
        <div className="signing-key-state">
          <Shield aria-hidden="true" /> No verification keys configured.
        </div>
      ) : null}
    </SettingsCard>
  );
}

export function SigningKeyDialogs({
  confirmation,
  pending,
  finalFocus,
  onConfirmation,
  onConfirm,
}: {
  readonly confirmation?: SigningKeyConfirmation;
  readonly pending: boolean;
  readonly finalFocus: React.RefObject<HTMLElement | null>;
  readonly onConfirmation: (value?: SigningKeyConfirmation) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogRoot
      open={confirmation !== undefined}
      onOpenChange={(open) => !open && onConfirmation(undefined)}
    >
      {confirmation === undefined ? null : (
        <DialogContent finalFocus={finalFocus}>
          <DialogTitle>
            {confirmation.kind === "rotate"
              ? "Rotate managed signing key?"
              : "Revoke key?"}
          </DialogTitle>
          <DialogDescription>
            {confirmation.kind === "rotate"
              ? "The current key will immediately stop signing new commits. Existing Git commits remain unchanged."
              : "This key will immediately stop being used for new signing or verification. Existing Git commits remain unchanged."}
          </DialogDescription>
          <div className="signing-key-dialog-actions">
            <Button variant="ghost" onClick={() => onConfirmation(undefined)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={onConfirm}>
              {confirmation.kind === "rotate" ? "Rotate key" : "Revoke key"}
            </Button>
          </div>
        </DialogContent>
      )}
    </DialogRoot>
  );
}
