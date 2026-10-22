import "./orb-providers.css";
import type { OrbProviderData, OrbProviderListData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { OrbIcon } from "../../../shared/ui/orb-icon.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  type OrbProviderAction,
  orbProvidersMutationOptions,
} from "./orb-providers-mutations.js";
import {
  orbProvidersQueryOptions,
  type PluginsTarget,
} from "./orb-providers-queries.js";
import {
  orbKeyPlaceholder,
  orbProviderSource,
} from "./orb-providers-status.js";

/** Resolves to the error message, or undefined when the action succeeded. */
type Run = (
  action: OrbProviderAction,
  success: string,
) => Promise<string | undefined>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/** The row's status: whose account runs the Orbs, and where a key stops. */
const rowStatus = (data: OrbProviderListData, provider: OrbProviderData) => {
  const source = orbProviderSource(provider, data.scope);
  return data.scope === "personal" &&
    provider.key !== null &&
    !data.localRuntime &&
    data.personalKeysOnWorkspaceProjects !== null &&
    !data.personalKeysOnWorkspaceProjects.allowed
    ? `${source} · Personal projects only`
    : source;
};

function OrbProviderRow({
  data,
  provider,
  onOpenKey,
}: {
  readonly data: OrbProviderListData;
  readonly provider: OrbProviderData;
  readonly onOpenKey: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="orb-provider-row" data-provider={provider.id}>
      <span className="orb-provider-mark">
        <OrbIcon aria-hidden="true" />
      </span>
      <div className="orb-provider-copy">
        <strong>{provider.displayName}</strong>
        <p>{rowStatus(data, provider)}</p>
      </div>
      {provider.credentialLabel === null ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={!data.canUpdate}
          aria-label={`${provider.key === null ? "Add" : "Manage"} ${provider.displayName} key`}
          onClick={(event) => onOpenKey(event.currentTarget)}
        >
          {provider.key === null ? "Add Key" : "Manage Key"}
        </Button>
      )}
    </div>
  );
}

/** One sentence, only when the key would not apply where the person expects. */
const keyNote = (
  data: OrbProviderListData,
  provider: OrbProviderData,
): string | undefined => {
  if (data.localRuntime) return "The local runtime ignores Orb keys.";
  if (provider.key?.template?.status === "failed")
    return `${provider.key.template.error ?? "The template build failed."} Save the key again to retry.`;
  if (
    data.scope === "personal" &&
    data.personalKeysOnWorkspaceProjects !== null &&
    !data.personalKeysOnWorkspaceProjects.allowed
  )
    return "Your workspace keeps members' own keys off its projects, so this key runs your personal projects only.";
  return undefined;
};

function OrbKeyForm({
  data,
  provider,
  busy,
  run,
  onDirtyChange,
  onDone,
}: {
  readonly data: OrbProviderListData;
  readonly provider: OrbProviderData;
  readonly busy: boolean;
  readonly run: Run;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onDone: () => void;
}) {
  const [credential, setCredential] = React.useState("");
  // A rejected key is the likely failure here; say so beside the field.
  const [failure, setFailure] = React.useState<string>();
  const disabled = !data.canUpdate || busy;
  const label = provider.credentialLabel ?? "API key";
  const fieldId = React.useId();
  const note = keyNote(data, provider);
  const edit = (value: string) => {
    setCredential(value);
    onDirtyChange(value.length > 0);
  };
  return (
    <form
      className="orb-key-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const error = await run(
          {
            type: "saveKey",
            providerId: provider.id,
            credential: credential.trim(),
          },
          `${provider.displayName} key saved.`,
        );
        setFailure(error);
        if (error === undefined) {
          edit("");
          onDone();
        }
      }}
    >
      {note === undefined ? null : <p>{note}</p>}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      <div className="orb-key-field">
        <label htmlFor={fieldId}>{label}</label>
        <Input
          id={fieldId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={orbKeyPlaceholder(provider)}
          value={credential}
          disabled={disabled}
          onChange={(event) => edit(event.target.value)}
        />
      </div>
      <footer>
        {provider.key === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={disabled}
            onClick={async () => {
              const error = await run(
                { type: "removeKey", providerId: provider.id },
                `${provider.displayName} key removed.`,
              );
              setFailure(error);
              if (error === undefined) onDone();
            }}
          >
            Remove Key
          </Button>
        )}
        <Button
          size="xs"
          type="submit"
          disabled={disabled || credential.trim().length === 0}
        >
          Save
        </Button>
      </footer>
    </form>
  );
}

export function OrbProvidersSettings({
  workspaceSlug,
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const target: PluginsTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  const resource = useQuery(orbProvidersQueryOptions(identity.id, target));
  const mutation = useMutation(
    orbProvidersMutationOptions(queryClient, identity.id, target),
  );
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const [editing, setEditing] = React.useState<string>();
  const finalFocus = React.useRef<HTMLElement | null>(null);
  const run: Run = async (action, success) => {
    setBusy(true);
    setMessage(undefined);
    const outcome = await settle(async () => {
      await mutation.mutateAsync(action);
      setMessage(success);
    });
    if (!outcome.ok) setMessage(errorMessage(outcome.error));
    setBusy(false);
    mutation.reset();
    return outcome.ok ? undefined : errorMessage(outcome.error);
  };
  const close = () => {
    setEditing(undefined);
    onDirtyChange(false);
  };
  const data = resource.data;
  const editingProvider = data?.providers.find(({ id }) => id === editing);
  const policy = data?.personalKeysOnWorkspaceProjects;
  // Keys and the policy on them matter only where a provider takes a key.
  const keyed =
    data?.providers.some(({ credentialLabel }) => credentialLabel !== null) ??
    false;
  return (
    <div className="orb-providers-settings">
      <SettingsHeading
        title={
          target.scope === "workspace"
            ? "Workspace Orb Providers"
            : "Orb Providers"
        }
        description={
          data === undefined
            ? undefined
            : target.scope === "workspace"
              ? keyed
                ? "Orbs run the dx Threads of everyone in this workspace. A workspace key runs them in the workspace's provider account instead of this deployment's."
                : "Orbs run the dx Threads of everyone in this workspace on the providers this deployment offers."
              : keyed
                ? "Orbs run your dx Threads. Your own key runs them in your provider account, ahead of your workspace's key and this deployment's. On workspace projects it applies only when the workspace allows members' own keys."
                : "Orbs run your dx Threads on the providers this deployment offers."
        }
        actions={
          resource.isPending ? null : (
            <span aria-live="polite">
              {resource.error !== null ? errorMessage(resource.error) : message}
            </span>
          )
        }
      />
      {resource.isPending ? <DxLoading label="Loading Orb providers…" /> : null}
      {data === undefined ? null : (
        <SettingsCard>
          {data.providers.map((provider) => (
            <OrbProviderRow
              key={provider.id}
              data={data}
              provider={provider}
              onOpenKey={(trigger) => {
                finalFocus.current = trigger;
                setEditing(provider.id);
              }}
            />
          ))}
        </SettingsCard>
      )}
      {data === undefined ||
      !keyed ||
      target.scope !== "workspace" ||
      policy === null ||
      policy === undefined ? null : (
        <SettingsCard>
          <SettingsRow
            title="Members' Own Keys"
            description={
              policy.pluginOverridesAllowed
                ? "Members' own keys run their Orbs on this workspace's projects, ahead of the workspace key."
                : "Off while the workspace policy turns off members' own plugin settings."
            }
            control={
              <SettingsToggle
                checked={policy.allowed}
                disabled={
                  !data.canUpdate || busy || !policy.pluginOverridesAllowed
                }
                label="Members' own keys on workspace projects"
                onCheckedChange={(value) =>
                  void run(
                    {
                      type: "policy",
                      allowPersonalKeysOnWorkspaceProjects: value,
                    },
                    value
                      ? "Members' own keys allowed."
                      : "Members' own keys turned off.",
                  )
                }
              />
            }
          />
        </SettingsCard>
      )}
      <DialogRoot
        open={editingProvider !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {editingProvider === undefined || data === undefined ? null : (
          <DialogContent finalFocus={finalFocus} className="orb-key-dialog">
            <DialogTitle>{editingProvider.displayName}</DialogTitle>
            <OrbKeyForm
              key={editingProvider.id}
              data={data}
              provider={editingProvider}
              busy={busy}
              run={run}
              onDirtyChange={onDirtyChange}
              onDone={close}
            />
          </DialogContent>
        )}
      </DialogRoot>
    </div>
  );
}
