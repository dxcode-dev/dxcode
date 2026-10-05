import type { OrbProviderData, OrbProviderListData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
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

type Scope = "personal" | "workspace";
/** Resolves to the error message, or undefined when the action succeeded. */
type Run = (
  action: OrbProviderAction,
  success: string,
) => Promise<string | undefined>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

function OrbProviderRow({
  provider,
  scope,
  onOpenSettings,
}: {
  readonly provider: OrbProviderData;
  readonly scope: Scope;
  readonly onOpenSettings: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="first-party-plugin-row orb-provider-row">
      <span className="first-party-plugin-creator">
        <OrbIcon aria-hidden="true" />
      </span>
      <strong>{provider.displayName}</strong>
      <span>{orbProviderSource(provider, scope)}</span>
      {provider.credentialLabel === null ? null : (
        <Button
          size="icon-xs"
          variant="ghost"
          className="orb-provider-action"
          aria-label={`${provider.displayName} settings`}
          onClick={(event) => onOpenSettings(event.currentTarget)}
        >
          <Settings />
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
    return "Applies to your personal projects. Your workspace decides for its projects.";
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
  const note = keyNote(data, provider);
  const edit = (value: string) => {
    setCredential(value);
    onDirtyChange(value.length > 0);
  };
  return (
    <form
      className="first-party-plugin-form"
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
      <SettingsRow
        title={label}
        control={
          <Input
            aria-label={label}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={orbKeyPlaceholder(provider)}
            value={credential}
            disabled={disabled}
            onChange={(event) => edit(event.target.value)}
          />
        }
      />
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
            Remove key
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
  const target = React.useMemo<PluginsTarget>(
    () =>
      workspaceSlug === undefined
        ? { scope: "personal" }
        : { scope: "workspace", workspaceSlug },
    [workspaceSlug],
  );
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
    try {
      await mutation.mutateAsync(action);
      setMessage(success);
      return undefined;
    } catch (error) {
      setMessage(errorMessage(error));
      return errorMessage(error);
    } finally {
      setBusy(false);
      mutation.reset();
    }
  };
  const close = () => {
    setEditing(undefined);
    onDirtyChange(false);
  };
  const data = resource.data;
  const editingProvider = data?.providers.find(({ id }) => id === editing);
  const policy = data?.personalKeysOnWorkspaceProjects;
  return (
    <div className="first-party-plugins-settings">
      <header className="first-party-plugins-heading">
        <h1>
          {target.scope === "workspace"
            ? "Workspace Orb Providers"
            : "Orb Providers"}
        </h1>
        <span aria-live="polite">
          {resource.isPending
            ? "Loading Orb providers…"
            : resource.error !== null
              ? errorMessage(resource.error)
              : message}
        </span>
      </header>
      {data === undefined ? null : (
        <SettingsCard>
          {data.providers.map((provider) => (
            <OrbProviderRow
              key={provider.id}
              provider={provider}
              scope={target.scope}
              onOpenSettings={(trigger) => {
                finalFocus.current = trigger;
                setEditing(provider.id);
              }}
            />
          ))}
          {target.scope === "workspace" &&
          policy !== null &&
          policy !== undefined ? (
            <SettingsRow
              title="Members' own keys on workspace projects"
              badge={
                policy.pluginOverridesAllowed
                  ? undefined
                  : "Off for all plugins"
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
                      "Workspace Orb policy updated.",
                    )
                  }
                />
              }
            />
          ) : null}
        </SettingsCard>
      )}
      <DialogRoot
        open={editingProvider !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {editingProvider === undefined || data === undefined ? null : (
          <DialogContent
            finalFocus={finalFocus}
            className="first-party-plugin-dialog"
          >
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
