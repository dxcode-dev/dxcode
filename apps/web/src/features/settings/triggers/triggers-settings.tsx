import type { PluginTriggerId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings, Webhook } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { DialogContent, DialogRoot } from "../../../shared/ui/dialog.js";
import { environmentVariablesQueryOptions } from "../environment-variables/environment-variables-queries.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsToggle,
} from "../settings-primitives.js";
import {
  CreateTriggerForm,
  TriggerDetails,
  type TriggerRun,
  TriggerUrl,
} from "./trigger-dialogs.js";
import {
  type OneTimeTriggerCapability,
  type TriggerCapabilityAction,
  triggerCapabilityMutationOptions,
  triggersMutationOptions,
} from "./triggers-mutations.js";
import {
  type PluginTriggerData,
  triggersQueryOptions,
} from "./triggers-queries.js";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

type Dialog =
  | { readonly kind: "create" }
  | { readonly kind: "details"; readonly triggerId: PluginTriggerId }
  | {
      readonly kind: "url";
      readonly capability: OneTimeTriggerCapability;
      readonly signed: boolean;
    };

/** Why a trigger can't run as shown, in a few words; absent when it can. */
const triggerHint = (trigger: PluginTriggerData) =>
  trigger.deliverySummary.deadLetter > 0
    ? `${trigger.deliverySummary.deadLetter} failed`
    : undefined;

function TriggerRow({
  trigger,
  busy,
  run,
  onOpen,
}: {
  readonly trigger: PluginTriggerData;
  readonly busy: boolean;
  readonly run: TriggerRun;
  readonly onOpen: (opener: HTMLButtonElement) => void;
}) {
  const hint = triggerHint(trigger);
  const on = trigger.status === "active";
  const name = `${trigger.pluginDisplayName} ${trigger.capabilityName}`;
  return (
    <div className="first-party-plugin-row" data-plugin-trigger={trigger.id}>
      <span className="first-party-plugin-creator" aria-hidden="true">
        <Webhook />
      </span>
      <strong>{trigger.pluginDisplayName}</strong>
      <span>{hint ?? trigger.capabilityName}</span>
      <SettingsToggle
        checked={on}
        disabled={busy}
        label={`${name} ${on ? "on" : "off"}`}
        onCheckedChange={(checked) =>
          void run(
            {
              type: "updateState",
              triggerId: trigger.id,
              status: checked ? "active" : "paused",
            },
            `${trigger.pluginDisplayName} trigger ${checked ? "on" : "paused"}.`,
          )
        }
      />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`${name} settings`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <Settings />
      </Button>
    </div>
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
  const [dialog, setDialog] = React.useState<Dialog>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const [dialogError, setDialogError] = React.useState<string>();
  const finalFocus = React.useRef<HTMLElement | null>(null);
  const fail = (error: unknown) => {
    if (dialog === undefined) setMessage(errorMessage(error));
    else setDialogError(errorMessage(error));
  };
  const run: TriggerRun = async (action, success) => {
    setBusy(true);
    setMessage(undefined);
    setDialogError(undefined);
    const outcome = await settle(() => mutation.mutateAsync(action));
    if (outcome.ok) setMessage(success);
    else fail(outcome.error);
    setBusy(false);
    mutation.reset();
    return outcome.ok;
  };
  const runCapability = async (
    action: TriggerCapabilityAction,
    signed: boolean,
    success: string,
  ) => {
    setBusy(true);
    setMessage(undefined);
    setDialogError(undefined);
    const outcome = await settle(() => capabilityMutation.mutateAsync(action));
    if (outcome.ok) {
      setMessage(success);
      setDialog({ kind: "url", capability: outcome.value.capability, signed });
    } else fail(outcome.error);
    setBusy(false);
    capabilityMutation.reset();
  };
  const close = () => {
    setDialog(undefined);
    setDialogError(undefined);
  };
  const data = resource.data;
  const capabilities = data?.availableCapabilities ?? [];
  // A revoked trigger can't be restored, so it leaves the list.
  const triggers = (data?.items ?? []).filter(
    ({ status }) => status !== "revoked",
  );
  const secrets = (environment.data?.items ?? []).filter(
    (variable) => variable.kind === "secret" && variable.enabled,
  );
  const open = dialog?.kind === "details" ? dialog : undefined;
  const opened = triggers.find(({ id }) => id === open?.triggerId);
  return (
    <div className="plugin-triggers-settings">
      <SettingsHeading
        title="Triggers"
        description="Webhooks that run an action in a plugin you trust. Pausing stops new deliveries; one already running may still finish."
        actions={
          <span className="first-party-plugins-heading-actions">
            <span aria-live="polite">
              {resource.isPending
                ? "Loading triggers…"
                : resource.error !== null
                  ? errorMessage(resource.error)
                  : message}
            </span>
            {capabilities.length > 0 ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={(event) => {
                  finalFocus.current = event.currentTarget;
                  setDialog({ kind: "create" });
                }}
              >
                Create trigger
              </Button>
            ) : null}
          </span>
        }
      />
      {data === undefined ? null : (
        <SettingsCard>
          {triggers.length === 0 ? (
            <div className="settings-card-empty trigger-empty">
              <strong>No triggers yet</strong>
              <span>
                {capabilities.length === 0
                  ? "Triggers come from plugins that declare them. Trust a plugin with a webhook trigger, then create the trigger here to get its URL."
                  : "Create a trigger to get a webhook URL for a plugin you trust."}
              </span>
            </div>
          ) : (
            triggers.map((trigger) => (
              <TriggerRow
                key={trigger.id}
                trigger={trigger}
                busy={busy}
                run={run}
                onOpen={(opener) => {
                  finalFocus.current = opener;
                  setDialog({ kind: "details", triggerId: trigger.id });
                  // Deliveries arrive from outside; show the latest.
                  void resource.refetch();
                }}
              />
            ))
          )}
        </SettingsCard>
      )}
      <DialogRoot
        open={dialog !== undefined}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        {dialog === undefined ? null : (
          <DialogContent
            finalFocus={finalFocus}
            className="plugin-bundle-dialog"
          >
            {dialog.kind === "create" ? (
              <CreateTriggerForm
                capabilities={capabilities}
                secrets={secrets}
                busy={busy}
                {...(dialogError === undefined ? {} : { error: dialogError })}
                onCancel={close}
                onCreate={(capability, secret) =>
                  void runCapability(
                    {
                      type: "create",
                      input: {
                        pluginId: capability.pluginId,
                        pluginVersion: capability.version,
                        capabilityName: capability.capabilityName,
                        ...(secret === undefined
                          ? {}
                          : { hmacSecretReference: secret.reference }),
                      },
                    },
                    secret !== undefined,
                    `${capability.pluginDisplayName} trigger created.`,
                  )
                }
              />
            ) : dialog.kind === "url" ? (
              <TriggerUrl
                capability={dialog.capability}
                signed={dialog.signed}
                onDone={close}
              />
            ) : opened === undefined ? null : (
              <TriggerDetails
                key={opened.id}
                trigger={opened}
                busy={busy}
                {...(dialogError === undefined ? {} : { error: dialogError })}
                run={run}
                onRotate={() =>
                  void runCapability(
                    { type: "rotate", triggerId: opened.id },
                    opened.hmacConfigured,
                    `${opened.pluginDisplayName} trigger has a new URL.`,
                  )
                }
                onDone={close}
              />
            )}
          </DialogContent>
        )}
      </DialogRoot>
    </div>
  );
}
