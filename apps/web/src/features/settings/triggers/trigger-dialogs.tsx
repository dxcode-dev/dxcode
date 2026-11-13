import type { PluginTriggerDeliveryId } from "@dx/domain";
import { Webhook } from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { PluginStatusBadge } from "../plugins/plugin-status-badge.js";
import { SettingsSelect } from "../settings-primitives.js";
import type {
  OneTimeTriggerCapability,
  TriggersMutationAction,
} from "./triggers-mutations.js";
import type {
  EnvironmentVariableData,
  PluginTriggerData,
  TriggerPluginCapabilityData,
} from "./triggers-queries.js";

export type TriggerRun = (
  action: TriggersMutationAction,
  success: string,
) => Promise<boolean>;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** How to send an event, shown wherever the URL is. */
function WebhookContract({ signed }: { readonly signed: boolean }) {
  return (
    <p className="plugin-bundle-help">
      POST JSON <code>{'{"event", "data"}'}</code> with the{" "}
      <code>x-dx-timestamp</code>, <code>x-dx-event-id</code>, and{" "}
      <code>x-dx-idempotency-key</code> headers
      {signed ? (
        <>
          , signed in <code>x-dx-signature</code>
        </>
      ) : null}
      , up to 64 KB.
    </p>
  );
}

const capabilityKey = (capability: TriggerPluginCapabilityData) =>
  `${capability.pluginId}:${capability.version}:${capability.capabilityName}`;

export function CreateTriggerForm({
  capabilities,
  secrets,
  busy,
  error,
  onCancel,
  onCreate,
}: {
  readonly capabilities: ReadonlyArray<TriggerPluginCapabilityData>;
  readonly secrets: ReadonlyArray<EnvironmentVariableData>;
  readonly busy: boolean;
  readonly error?: string;
  readonly onCancel: () => void;
  readonly onCreate: (
    capability: TriggerPluginCapabilityData,
    secret?: EnvironmentVariableData,
  ) => void;
}) {
  const [selectedKey, setSelectedKey] = React.useState(
    capabilities[0] === undefined ? "" : capabilityKey(capabilities[0]),
  );
  const [secretId, setSecretId] = React.useState("");
  const selected = capabilities.find(
    (capability) => capabilityKey(capability) === selectedKey,
  );
  const secret = secrets.find(({ reference }) => reference.id === secretId);
  return (
    <form
      className="plugin-bundle-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected !== undefined) onCreate(selected, secret);
      }}
    >
      <header>
        <DialogTitle>Create trigger</DialogTitle>
        <DialogDescription>
          dx gives you a webhook URL that runs the plugin's action.
        </DialogDescription>
      </header>
      <div className="plugin-bundle-field">
        <label htmlFor="plugin-trigger-capability">Plugin trigger</label>
        <SettingsSelect
          id="plugin-trigger-capability"
          label="Plugin trigger"
          value={selectedKey}
          options={capabilities.map((capability) => [
            capabilityKey(capability),
            `${capability.pluginDisplayName} · ${capability.capabilityName}`,
          ])}
          onValueChange={setSelectedKey}
        />
        {selected === undefined ? null : (
          <p className="plugin-bundle-help">
            Runs <code>{selected.action}</code> on <code>{selected.event}</code>{" "}
            events.
          </p>
        )}
      </div>
      <div className="plugin-bundle-field">
        <label htmlFor="plugin-trigger-secret">Signing secret</label>
        <SettingsSelect
          id="plugin-trigger-secret"
          label="Signing secret"
          value={secretId}
          options={[
            ["", "None, the URL alone"],
            ...secrets.map(
              ({ reference, name }) => [reference.id, name] as const,
            ),
          ]}
          onValueChange={setSecretId}
        />
      </div>
      {error === undefined ? null : (
        <p className="plugin-bundle-error" role="alert">
          {error}
        </p>
      )}
      <footer className="plugin-bundle-actions">
        <Button size="xs" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" type="submit" disabled={busy || !selected}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </footer>
    </form>
  );
}

/** The webhook URL, which dx shows once after create or a new URL. */
export function TriggerUrl({
  capability,
  signed,
  onDone,
}: {
  readonly capability: OneTimeTriggerCapability;
  readonly signed: boolean;
  readonly onDone: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="plugin-bundle-form">
      <header>
        <DialogTitle>Copy the webhook URL</DialogTitle>
        <DialogDescription>
          dx shows it only now. Anyone with it can send events, so store it as a
          secret.
        </DialogDescription>
      </header>
      <div className="plugin-bundle-field">
        <label htmlFor="plugin-trigger-url">Webhook URL</label>
        <span className="trigger-url">
          <Input
            id="plugin-trigger-url"
            readOnly
            spellCheck={false}
            value={capability.capabilityUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            size="xs"
            variant="outline"
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(capability.capabilityUrl);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </span>
      </div>
      <WebhookContract signed={signed} />
      <footer className="plugin-bundle-actions">
        <Button size="xs" onClick={onDone}>
          Done
        </Button>
      </footer>
    </div>
  );
}

const deliveryStatus = {
  pending: { label: "Waiting", tone: undefined },
  "in-flight": { label: "Running", tone: undefined },
  succeeded: { label: "Delivered", tone: "added" },
  "dead-letter": { label: "Failed", tone: "removed" },
  cancelled: { label: "Cancelled", tone: "unchanged" },
} as const;

const failureLabel = {
  "execution-unavailable": "plugin runtime unavailable",
  "execution-limited": "plugin hit a limit",
  "plugin-disabled": "plugin turned off",
  "lease-expired": "timed out",
} as const;

export function TriggerDetails({
  trigger,
  busy,
  error,
  run,
  onRotate,
  onDone,
}: {
  readonly trigger: PluginTriggerData;
  readonly busy: boolean;
  readonly error?: string;
  readonly run: TriggerRun;
  readonly onRotate: () => void;
  readonly onDone: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [revokeFailed, setRevokeFailed] = React.useState(false);
  const retry = (deliveryId: PluginTriggerDeliveryId) =>
    void run(
      { type: "retryDelivery", triggerId: trigger.id, deliveryId },
      "Delivery queued again.",
    );
  return (
    <div className="plugin-bundle-form">
      <header>
        <DialogTitle>{trigger.pluginDisplayName}</DialogTitle>
        <p className="plugin-bundle-source-line">
          <Webhook aria-hidden="true" />
          <span>{trigger.capabilityName}</span>
          <span>version {trigger.pluginVersion}</span>
        </p>
        <DialogDescription>
          Runs <code>{trigger.action}</code> on <code>{trigger.event}</code>{" "}
          events.{" "}
          {trigger.hmacConfigured
            ? "Events must be signed with its secret."
            : "Its URL alone authenticates events."}
        </DialogDescription>
      </header>
      <div className="plugin-bundle-items">
        <section className="plugin-bundle-group" aria-label="Deliveries">
          <h3>
            <span>Deliveries</span>
            <span className="plugin-bundle-count">
              {trigger.deliverySummary.succeeded} delivered
              {trigger.deliverySummary.deadLetter > 0
                ? ` · ${trigger.deliverySummary.deadLetter} failed`
                : ""}
            </span>
          </h3>
          <ul>
            {trigger.deliveries.length === 0 ? (
              <li>
                <span>No events yet.</span>
              </li>
            ) : (
              trigger.deliveries.map((delivery) => {
                const status = deliveryStatus[delivery.status];
                return (
                  <li key={delivery.id}>
                    <code title={delivery.eventId}>{delivery.eventId}</code>
                    <span>
                      {plural(delivery.attempts, "attempt", "attempts")}
                      {delivery.failureCode === undefined
                        ? ""
                        : `, ${failureLabel[delivery.failureCode]}`}
                    </span>
                    <PluginStatusBadge
                      tone={status.tone}
                      label={status.label}
                    />
                    {delivery.status === "dead-letter" &&
                    delivery.idempotent &&
                    trigger.status === "active" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => retry(delivery.id)}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </section>
      </div>
      <WebhookContract signed={trigger.hmacConfigured} />
      {error === undefined ? null : (
        <p className="plugin-bundle-error" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setRevokeFailed(false);
          setConfirming(open);
        }}
        {...(revokeFailed
          ? { error: "The URL wasn't revoked. Try again." }
          : {})}
        title={`Revoke ${trigger.pluginDisplayName}'s webhook URL?`}
        description="Events stop at once, and it can't be undone."
        confirmLabel={busy ? "Revoking…" : "Revoke"}
        destructive
        pending={busy}
        onConfirm={async () => {
          setRevokeFailed(false);
          const done = await run(
            { type: "revoke", triggerId: trigger.id },
            `${trigger.pluginDisplayName} trigger revoked.`,
          );
          // A failure stays in the dialog, where the person is looking.
          if (!done) return setRevokeFailed(true);
          setConfirming(false);
          onDone();
        }}
      />
      <footer className="plugin-bundle-actions">
        <Button
          size="xs"
          variant="danger"
          className="plugin-bundle-remove"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          Revoke
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={onRotate}>
          New URL
        </Button>
        <Button size="xs" onClick={onDone}>
          Done
        </Button>
      </footer>
    </div>
  );
}
