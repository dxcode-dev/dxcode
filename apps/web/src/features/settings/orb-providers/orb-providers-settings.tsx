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
  orbFieldPlaceholder,
  orbProviderSource,
  preparationStep,
} from "./orb-providers-status.js";

/** Resolves to the error message, or undefined when the action succeeded. */
type Run = (
  action: OrbProviderAction,
  success: string,
) => Promise<string | undefined>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/** The row's status: whose account runs the Orbs, and where it stops. */
const rowStatus = (data: OrbProviderListData, provider: OrbProviderData) => {
  const source = orbProviderSource(provider, data.scope);
  return data.scope === "personal" &&
    provider.connection !== null &&
    !data.localRuntime &&
    data.personalKeysOnWorkspaceProjects !== null &&
    !data.personalKeysOnWorkspaceProjects.allowed
    ? `${source} · Personal projects only`
    : source;
};

function OrbProviderRow({
  data,
  provider,
  onOpen,
}: {
  readonly data: OrbProviderListData;
  readonly provider: OrbProviderData;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
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
      {provider.fields.length === 0 ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={!data.canUpdate}
          aria-label={`${provider.connection === null ? "Connect" : "Manage"} ${provider.displayName}`}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          {provider.connection === null ? "Connect" : "Manage"}
        </Button>
      )}
    </div>
  );
}

/** One sentence, only when the connection needs attention or stops short. */
const connectionNote = (
  data: OrbProviderListData,
  provider: OrbProviderData,
): string | undefined => {
  if (data.localRuntime) return "The local runtime ignores Orb connections.";
  const connection = provider.connection;
  const keepsServing = connection?.updating === true;
  if (connection?.status === "preparing") {
    const step = preparationStep(connection);
    return keepsServing
      ? `Updating: ${step} New Threads keep using the current version until it is ready.`
      : `${step} This takes a few minutes; you can close this dialog.`;
  }
  if (connection?.status === "failed")
    return keepsServing
      ? `The update failed: ${connection.error ?? "unknown error"} New Threads keep using the current version.`
      : (connection.error ?? "Setting up your account failed.");
  if (
    data.scope === "personal" &&
    data.personalKeysOnWorkspaceProjects !== null &&
    !data.personalKeysOnWorkspaceProjects.allowed
  )
    return "Your workspace keeps members' own accounts off its projects, so this runs your personal projects only.";
  if (connection !== null && connection.unavailableSizes.length > 0)
    return `${refusedSizes(provider, connection)} dx checks again daily, so new sizes appear after a plan upgrade.`;
  return connection === null ? provider.description : undefined;
};

/** The sizes the account cannot run, each with the provider's reason. */
const refusedSizes = (
  provider: OrbProviderData,
  connection: NonNullable<OrbProviderData["connection"]>,
) =>
  connection.unavailableSizes
    .map(({ id, reason }) => {
      const label = provider.sizes.find((size) => size.id === id)?.label ?? id;
      return `${label} is not available: ${reason}`;
    })
    .join(" ");

function OrbConnectionForm({
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
  const [values, setValues] = React.useState<Record<string, string>>({});
  // A rejected credential is the likely failure here; say so beside it.
  const [failure, setFailure] = React.useState<string>();
  const disabled = !data.canUpdate || busy;
  const formId = React.useId();
  const note = connectionNote(data, provider);
  const failed = provider.connection?.status === "failed";
  // A plan upgrade may have opened sizes the account could not run.
  const lacksSizes =
    provider.connection?.status === "ready" &&
    provider.connection.unavailableSizes.length > 0;
  const complete = provider.fields.every(
    ({ id }) => (values[id] ?? "").trim().length > 0,
  );
  const edit = (id: string, value: string) => {
    const next = { ...values, [id]: value };
    setValues(next);
    onDirtyChange(Object.values(next).some((entry) => entry.length > 0));
  };
  return (
    <form
      className="orb-key-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const error = await run(
          {
            type: "connect",
            providerId: provider.id,
            credentials: Object.fromEntries(
              provider.fields.map(({ id }) => [id, (values[id] ?? "").trim()]),
            ),
          },
          `${provider.displayName} connected.`,
        );
        setFailure(error);
        if (error === undefined) {
          setValues({});
          onDirtyChange(false);
          onDone();
        }
      }}
    >
      {note === undefined ? null : (
        <p {...(failed ? { role: "alert" } : {})}>{note}</p>
      )}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      {provider.fields.map((field) => (
        <div className="orb-key-field" key={field.id}>
          <label htmlFor={`${formId}-${field.id}`}>{field.label}</label>
          <Input
            id={`${formId}-${field.id}`}
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={orbFieldPlaceholder(provider, field)}
            value={values[field.id] ?? ""}
            disabled={disabled}
            onChange={(event) => edit(field.id, event.target.value)}
          />
          {field.help === undefined ? null : <small>{field.help}</small>}
        </div>
      ))}
      <footer>
        {provider.connection === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={disabled}
            onClick={async () => {
              const error = await run(
                { type: "disconnect", providerId: provider.id },
                `${provider.displayName} disconnected.`,
              );
              setFailure(error);
              if (error === undefined) onDone();
            }}
          >
            Disconnect
          </Button>
        )}
        {failed || lacksSizes ? (
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={async () => {
              setFailure(
                await run(
                  { type: "retry", providerId: provider.id },
                  failed
                    ? `Preparing ${provider.displayName} again.`
                    : `Checking ${provider.displayName} for more sizes.`,
                ),
              );
            }}
          >
            {failed ? "Retry" : "Check again"}
          </Button>
        ) : null}
        <Button size="xs" type="submit" disabled={disabled || !complete}>
          {provider.connection === null ? "Connect" : "Save"}
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
  // The policy on members' own accounts matters only where one can connect.
  const connectable =
    data?.providers.some(({ fields }) => fields.length > 0) ?? false;
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
              ? "Orbs run the dx Threads of everyone in this workspace. Connect the workspace's own provider accounts to run them there."
              : "Orbs run your dx Threads. Connect your own provider account to run them there, ahead of your workspace's. On workspace projects it applies only when the workspace allows members' own accounts."
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
              onOpen={(trigger) => {
                finalFocus.current = trigger;
                setEditing(provider.id);
              }}
            />
          ))}
        </SettingsCard>
      )}
      {data === undefined ||
      !connectable ||
      target.scope !== "workspace" ||
      policy === null ||
      policy === undefined ? null : (
        <SettingsCard>
          <SettingsRow
            title="Members' Own Accounts"
            description={
              policy.pluginOverridesAllowed
                ? "Members' own provider accounts run their Orbs on this workspace's projects, ahead of the workspace's."
                : "Off while the workspace policy turns off members' own plugin settings."
            }
            control={
              <SettingsToggle
                checked={policy.allowed}
                disabled={
                  !data.canUpdate || busy || !policy.pluginOverridesAllowed
                }
                label="Members' own accounts on workspace projects"
                onCheckedChange={(value) =>
                  void run(
                    {
                      type: "policy",
                      allowPersonalKeysOnWorkspaceProjects: value,
                    },
                    value
                      ? "Members' own accounts allowed."
                      : "Members' own accounts turned off.",
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
            <OrbConnectionForm
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
