import type { PluginTriggerDeliveryId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "effect";
import { Pause, Play, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { environmentVariablesQueryOptions } from "../environment-variables/environment-variables-queries.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsSelect,
} from "../settings-primitives.js";
import {
  type OneTimeTriggerCapability,
  type TriggerCapabilityAction,
  type TriggersMutationAction,
  triggerCapabilityMutationOptions,
  triggersMutationOptions,
} from "./triggers-mutations.js";
import {
  type EnvironmentVariableData,
  type PluginTriggerData,
  type TriggerPluginCapabilityData,
  triggersQueryOptions,
} from "./triggers-queries.js";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

type OneTimeCapability = OneTimeTriggerCapability;

function CapabilityDialog({
  capability,
  onClose,
}: {
  readonly capability: OneTimeCapability;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="trigger-dialog">
        <DialogTitle>Copy this capability now</DialogTitle>
        <DialogDescription>
          The URL and token will never be displayed again. Store the URL as a
          secret and do not put it in logs or source control.
        </DialogDescription>
        <label>
          Capability URL
          <textarea readOnly rows={4} value={capability.capabilityUrl} />
        </label>
        <label>
          Token
          <input readOnly value={capability.token} />
        </label>
        <footer className="trigger-dialog-actions">
          <Button onClick={onClose}>I have stored it</Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="trigger-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <footer className="trigger-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

function CreateDialog({
  capabilities,
  secrets,
  busy,
  onClose,
  onCreate,
}: {
  readonly capabilities: ReadonlyArray<TriggerPluginCapabilityData>;
  readonly secrets: ReadonlyArray<EnvironmentVariableData>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onCreate: (
    capability: TriggerPluginCapabilityData,
    secret?: EnvironmentVariableData,
  ) => void;
}) {
  const [capabilityKey, setCapabilityKey] = React.useState(
    capabilities[0] === undefined
      ? ""
      : `${capabilities[0].pluginId}:${capabilities[0].version}:${capabilities[0].capabilityName}`,
  );
  const [secretId, setSecretId] = React.useState("");
  const selected = capabilities.find(
    (capability) =>
      `${capability.pluginId}:${capability.version}:${capability.capabilityName}` ===
      capabilityKey,
  );
  const selectedSecret = secrets.find(
    (secret) => secret.reference.id === secretId,
  );
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="trigger-dialog">
        <DialogTitle>Create a plugin trigger</DialogTitle>
        <DialogDescription>
          Only trigger capabilities from a currently trusted, enabled plugin
          version are available. Creating a capability requires recent
          authentication.
        </DialogDescription>
        <label htmlFor="plugin-trigger-capability">
          Plugin capability
          <SettingsSelect
            id="plugin-trigger-capability"
            value={capabilityKey}
            label="Plugin trigger capability"
            options={capabilities.map((capability) => [
              `${capability.pluginId}:${capability.version}:${capability.capabilityName}`,
              `${capability.pluginDisplayName} · ${capability.capabilityName}`,
            ])}
            onValueChange={setCapabilityKey}
          />
        </label>
        {selected === undefined ? null : (
          <dl className="trigger-contract">
            <div>
              <dt>Version</dt>
              <dd>{selected.version}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{selected.sourceLabel}</dd>
            </div>
            <div>
              <dt>Event</dt>
              <dd>{selected.event}</dd>
            </div>
            <div>
              <dt>Action</dt>
              <dd>{selected.action}</dd>
            </div>
            <div>
              <dt>Permission</dt>
              <dd>{selected.permission}</dd>
            </div>
          </dl>
        )}
        <label htmlFor="plugin-trigger-hmac-secret">
          HMAC secret (optional encrypted reference)
          <SettingsSelect
            id="plugin-trigger-hmac-secret"
            value={secretId}
            label="Optional HMAC secret"
            options={[
              ["", "No HMAC signature"],
              ...secrets.map(
                (secret) =>
                  [
                    secret.reference.id,
                    `${secret.name} · ${secret.source}`,
                  ] as const,
              ),
            ]}
            onValueChange={setSecretId}
          />
        </label>
        <footer className="trigger-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || selected === undefined}
            onClick={() => selected && onCreate(selected, selectedSecret)}
          >
            {busy ? "Creating…" : "Create capability"}
          </Button>
        </footer>
      </DialogContent>
    </DialogRoot>
  );
}

type Confirmation =
  | { readonly type: "pause"; readonly trigger: PluginTriggerData }
  | { readonly type: "revoke"; readonly trigger: PluginTriggerData }
  | {
      readonly type: "retry";
      readonly trigger: PluginTriggerData;
      readonly deliveryId: PluginTriggerDeliveryId;
    };

function TriggerCard({
  trigger,
  busy,
  onPause,
  onResume,
  onRotate,
  onRevoke,
  onRetry,
}: {
  readonly trigger: PluginTriggerData;
  readonly busy: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRotate: () => void;
  readonly onRevoke: () => void;
  readonly onRetry: (deliveryId: PluginTriggerDeliveryId) => void;
}) {
  return (
    <article className="trigger-card">
      <header>
        <div>
          <h2>{trigger.pluginDisplayName}</h2>
          <p>
            <code>{trigger.pluginName}</code> · version {trigger.pluginVersion}
          </p>
        </div>
        <Badge>{trigger.status}</Badge>
      </header>
      <div className="trigger-badges">
        <Badge>{trigger.source}</Badge>
        <Badge>{trigger.event}</Badge>
        <Badge>Action: {trigger.action}</Badge>
        <Badge>Permission: {trigger.permission}</Badge>
        <Badge>{trigger.idempotent ? "Idempotent" : "Single attempt"}</Badge>
        <Badge>{trigger.hmacConfigured ? "HMAC" : "Capability token"}</Badge>
      </div>
      <dl className="trigger-contract">
        <div>
          <dt>Source</dt>
          <dd>{trigger.sourceLabel}</dd>
        </div>
        <div>
          <dt>Capability</dt>
          <dd>{trigger.capabilityName}</dd>
        </div>
        <div>
          <dt>Pending / in flight</dt>
          <dd>
            {trigger.deliverySummary.pending} /{" "}
            {trigger.deliverySummary.inFlight}
          </dd>
        </div>
        <div>
          <dt>Succeeded / dead letter</dt>
          <dd>
            {trigger.deliverySummary.succeeded} /{" "}
            {trigger.deliverySummary.deadLetter}
          </dd>
        </div>
      </dl>
      <div className="trigger-actions">
        {trigger.status === "active" ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={onPause}>
            <Pause /> Pause
          </Button>
        ) : trigger.status === "paused" ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={onResume}>
            <Play /> Resume
          </Button>
        ) : null}
        {trigger.status !== "revoked" ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={onRotate}
            >
              <RotateCw /> Rotate
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={onRevoke}
            >
              <Trash2 /> Revoke
            </Button>
          </>
        ) : null}
      </div>
      <details
        className="trigger-history"
        open={trigger.deliverySummary.deadLetter > 0}
      >
        <summary>Delivery history ({trigger.deliveries.length})</summary>
        {trigger.deliveries.length === 0 ? (
          <p>No webhook deliveries yet.</p>
        ) : (
          <div className="trigger-history-scroll">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Failure</th>
                  <th>Next attempt</th>
                  <th>Updated</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {trigger.deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>
                      <code>{delivery.eventId}</code>
                    </td>
                    <td>{delivery.status}</td>
                    <td>{delivery.attempts}</td>
                    <td>{delivery.failureCode ?? "—"}</td>
                    <td>
                      {delivery.nextAttemptAt === undefined
                        ? "—"
                        : new Date(
                            DateTime.formatIso(delivery.nextAttemptAt),
                          ).toLocaleString()}
                    </td>
                    <td>
                      {new Date(
                        DateTime.formatIso(delivery.updatedAt),
                      ).toLocaleString()}
                    </td>
                    <td>
                      {delivery.status === "dead-letter" &&
                      delivery.idempotent ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy || trigger.status !== "active"}
                          onClick={() => onRetry(delivery.id)}
                        >
                          <RefreshCw /> Retry
                        </Button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </article>
  );
}

export function PluginTriggersSettings() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const resource = useQuery(triggersQueryOptions(identity.id));
  const environment = useQuery(
    environmentVariablesQueryOptions(identity.id, { scope: "personal" }),
  );
  const mutation = useMutation(
    triggersMutationOptions(queryClient, identity.id),
  );
  const capabilityMutation = useMutation(
    triggerCapabilityMutationOptions(queryClient, identity.id),
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [capability, setCapability] = React.useState<OneTimeCapability>();
  const [confirmation, setConfirmation] = React.useState<Confirmation>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const secrets = (environment.data?.items ?? []).filter(
    (variable) => variable.kind === "secret" && variable.enabled,
  );
  const run = async (action: TriggersMutationAction, success: string) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await mutation.mutateAsync(action);
      setMessage(success);
      return result;
    } catch (error) {
      setMessage(errorMessage(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const runCapability = async (
    action: TriggerCapabilityAction,
    success: string,
  ) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await capabilityMutation.mutateAsync(action);
      setCapability(result.capability);
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
      capabilityMutation.reset();
    }
  };
  const confirm = () => {
    if (confirmation === undefined) return;
    if (confirmation.type === "pause") {
      void run(
        {
          type: "updateState",
          triggerId: confirmation.trigger.id,
          status: "paused",
        },
        "Trigger paused. In-flight delivery state remains visible.",
      ).then(() => setConfirmation(undefined));
    } else if (confirmation.type === "revoke") {
      void run(
        { type: "revoke", triggerId: confirmation.trigger.id },
        "Trigger capability revoked.",
      ).then(() => setConfirmation(undefined));
    } else {
      void run(
        {
          type: "retryDelivery",
          triggerId: confirmation.trigger.id,
          deliveryId: confirmation.deliveryId,
        },
        "Dead-letter delivery queued for retry.",
      ).then(() => setConfirmation(undefined));
    }
  };
  const confirmationCopy =
    confirmation?.type === "pause"
      ? {
          title: "Pause this trigger?",
          description:
            "No new delivery will start. A delivery already in flight is not relabelled or interrupted.",
          label: "Pause trigger",
        }
      : confirmation?.type === "revoke"
        ? {
            title: "Revoke this capability?",
            description:
              "The current URL stops accepting events immediately. It cannot be restored and no token is retained.",
            label: "Revoke capability",
          }
        : {
            title: "Retry this dead letter?",
            description:
              "Only this terminal delivery is retried. The plugin declared this action idempotent.",
            label: "Retry delivery",
          };
  return (
    <div className="plugin-triggers-settings">
      <SettingsHeading
        title="Plugin Triggers"
        description="Authenticated personal webhooks with durable, at-least-once delivery to trusted plugin actions."
      />
      <SettingsCard title="Webhook contract">
        <div className="trigger-toolbar">
          <p>
            Send JSON with timestamp, event, and idempotency headers. Optional
            HMAC uses an encrypted personal secret reference. Payloads are
            bounded to{" "}
            {resource.data?.webhookContract.maxPayloadBytes.toLocaleString() ??
              "65,536"}{" "}
            bytes.
          </p>
          <Button
            disabled={
              busy || (resource.data?.availableCapabilities.length ?? 0) === 0
            }
            onClick={() => setCreateOpen(true)}
          >
            <Plus /> Create trigger
          </Button>
        </div>
        <div aria-live="polite" className="trigger-message">
          {resource.isPending || environment.isPending
            ? "Loading plugin triggers…"
            : ((resource.error === null
                ? undefined
                : errorMessage(resource.error)) ??
              (environment.error === null
                ? undefined
                : errorMessage(environment.error)) ??
              message)}
        </div>
        {resource.data?.availableCapabilities.length === 0 &&
        !resource.isPending ? (
          <p>
            No trusted, enabled plugin version currently grants a trigger
            capability.
          </p>
        ) : null}
      </SettingsCard>
      <SettingsCard title="Personal triggers">
        <div className="trigger-grid">
          {resource.data?.items.length === 0 && !resource.isPending ? (
            <p>No personal plugin triggers configured.</p>
          ) : null}
          {resource.data?.items.map((trigger) => (
            <TriggerCard
              key={trigger.id}
              trigger={trigger}
              busy={busy}
              onPause={() => setConfirmation({ type: "pause", trigger })}
              onResume={() =>
                void run(
                  {
                    type: "updateState",
                    triggerId: trigger.id,
                    status: "active",
                  },
                  "Trigger resumed and pending work scheduled.",
                )
              }
              onRotate={() =>
                void runCapability(
                  { type: "rotate", triggerId: trigger.id },
                  "Trigger capability rotated.",
                )
              }
              onRevoke={() => setConfirmation({ type: "revoke", trigger })}
              onRetry={(deliveryId) =>
                setConfirmation({ type: "retry", trigger, deliveryId })
              }
            />
          ))}
        </div>
      </SettingsCard>
      {createOpen && resource.data ? (
        <CreateDialog
          capabilities={resource.data.availableCapabilities}
          secrets={secrets}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onCreate={(selected, secret) =>
            void runCapability(
              {
                type: "create",
                input: {
                  pluginId: selected.pluginId,
                  pluginVersion: selected.version,
                  capabilityName: selected.capabilityName,
                  ...(secret === undefined
                    ? {}
                    : { hmacSecretReference: secret.reference }),
                },
              },
              "Plugin trigger created.",
            ).then((created) => {
              if (created) setCreateOpen(false);
            })
          }
        />
      ) : null}
      {capability ? (
        <CapabilityDialog
          capability={capability}
          onClose={() => setCapability(undefined)}
        />
      ) : null}
      {confirmation ? (
        <ConfirmDialog
          title={confirmationCopy.title}
          description={confirmationCopy.description}
          confirmLabel={confirmationCopy.label}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
          onConfirm={confirm}
        />
      ) : null}
    </div>
  );
}
