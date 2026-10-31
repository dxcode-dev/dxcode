import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxWordmark } from "../../../shared/brand/dx-wordmark.js";
import { settingsNavigationState } from "../../../shared/navigation/settings-return.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { ImportPluginDialog } from "./import-plugin-dialog.js";
import { PluginBundleDetails } from "./plugin-bundle-details.js";
import {
  pluginBundlePreviewMutationOptions,
  pluginBundlesMutationOptions,
  pluginBundleUpdatePreviewMutationOptions,
} from "./plugin-bundle-mutations.js";
import type { BundleRun } from "./plugin-bundle-presentation.js";
import { pluginBundlesQueryOptions } from "./plugin-bundle-queries.js";
import { PluginBundleRow } from "./plugin-bundle-row.js";
import {
  type FirstPartyPluginAction,
  firstPartyPluginsMutationOptions,
} from "./plugins-mutations.js";
import {
  type FirstPartyPluginData,
  firstPartyPluginsQueryOptions,
  type PluginsTarget,
} from "./plugins-queries.js";
import {
  credentialPlaceholder,
  listedPlugins,
  pluginHint,
  pluginSwitch,
} from "./plugins-status.js";

type Scope = "personal" | "workspace";
type Run = (
  action: FirstPartyPluginAction,
  success: string,
) => Promise<boolean>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

function PluginRow({
  plugin,
  scope,
  canUpdate,
  busy,
  run,
  onOpenSettings,
}: {
  readonly plugin: FirstPartyPluginData;
  readonly scope: Scope;
  readonly canUpdate: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onOpenSettings: (trigger: HTMLButtonElement) => void;
}) {
  const toggle = pluginSwitch(plugin, scope);
  const hint = pluginHint(plugin, scope);
  return (
    <div className="first-party-plugin-row">
      <span className="first-party-plugin-creator">
        <DxWordmark size="small" />
      </span>
      <strong>{plugin.displayName}</strong>
      {hint === undefined ? null : <span>{hint}</span>}
      <SettingsToggle
        checked={toggle.checked}
        disabled={!canUpdate || busy || toggle.locked}
        label={`${plugin.displayName} ${toggle.checked ? "on" : "off"}`}
        onCheckedChange={(checked) =>
          void run(
            {
              type: "enablement",
              pluginId: plugin.id,
              enablement: checked ? "enabled" : "disabled",
            },
            `${plugin.displayName} turned ${checked ? "on" : "off"}.`,
          )
        }
      />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`${plugin.displayName} settings`}
        onClick={(event) => onOpenSettings(event.currentTarget)}
      >
        <Settings />
      </Button>
    </div>
  );
}

function PluginSettingsForm({
  plugin,
  scope,
  canUpdate,
  busy,
  run,
  onDirtyChange,
  onDone,
}: {
  readonly plugin: FirstPartyPluginData;
  readonly scope: Scope;
  readonly canUpdate: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onDone: () => void;
}) {
  const keyed = plugin.providers.filter(
    (provider) => provider.credentialLabel !== null,
  );
  const [providerId, setProviderId] = React.useState(
    plugin.configuration?.providerId ?? keyed[0]?.id ?? "",
  );
  const [credential, setCredential] = React.useState("");
  const provider = keyed.find(({ id }) => id === providerId);
  const workspaceDecides =
    scope === "personal" && !plugin.personalOverridesAllowed;
  const disabled = !canUpdate || busy || workspaceDecides;
  const editCredential = (value: string) => {
    setCredential(value);
    onDirtyChange(value.length > 0);
  };
  if (provider === undefined) return null;
  return (
    <form
      className="first-party-plugin-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const saved = await run(
          {
            type: "configure",
            pluginId: plugin.id,
            providerId: provider.id,
            credential: credential.trim(),
          },
          `${provider.displayName} key saved.`,
        );
        if (saved) {
          editCredential("");
          onDone();
        }
      }}
    >
      {workspaceDecides ? (
        <p>Your workspace manages the provider and key for this plugin.</p>
      ) : null}
      <SettingsRow
        title="Provider"
        control={
          <SettingsSelect
            label="Provider"
            value={provider.id}
            disabled={disabled}
            options={keyed.map(({ id, displayName }) => [id, displayName])}
            onValueChange={(value) => {
              setProviderId(value as typeof providerId);
              editCredential("");
            }}
          />
        }
      />
      <SettingsRow
        title={provider.credentialLabel}
        control={
          <Input
            aria-label={provider.credentialLabel ?? "API key"}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={credentialPlaceholder(plugin, provider.id, scope)}
            value={credential}
            disabled={disabled}
            onChange={(event) => editCredential(event.target.value)}
          />
        }
      />
      <footer>
        {plugin.configuration === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={disabled}
            onClick={async () => {
              const removed = await run(
                { type: "removeConfiguration", pluginId: plugin.id },
                `${plugin.displayName} key removed.`,
              );
              if (removed) onDone();
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

/** The Personal / Workspace switch: a link to the other scope's page. */
function OtherScopeLink({
  scope,
  workspace,
  settingsReturnTo,
}: Pick<SettingsSectionProps, "workspace" | "settingsReturnTo"> & {
  readonly scope: Scope;
}) {
  const state = settingsNavigationState(settingsReturnTo);
  if (scope === "workspace")
    return (
      <Link
        to="/settings/$section"
        params={{ section: "plugins" }}
        replace
        state={state}
      >
        Personal Plugins
      </Link>
    );
  if (workspace === undefined) return null;
  return (
    <Link
      to="/workspaces/$workspaceSlug/$section"
      params={{ workspaceSlug: workspace.shortName, section: "plugins" }}
      replace
      state={state}
    >
      Workspace Plugins
    </Link>
  );
}

export function PluginsSettings({
  workspace,
  workspaceSlug,
  settingsReturnTo,
  onDirtyChange,
}: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const target: PluginsTarget =
    workspaceSlug === undefined
      ? { scope: "personal" }
      : { scope: "workspace", workspaceSlug };
  const resource = useQuery(firstPartyPluginsQueryOptions(identity.id, target));
  const mutation = useMutation(
    firstPartyPluginsMutationOptions(queryClient, identity.id, target),
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
    return outcome.ok;
  };
  const bundles = useQuery(pluginBundlesQueryOptions(identity.id, target));
  const bundleMutation = useMutation(
    pluginBundlesMutationOptions(queryClient, identity.id, target),
  );
  const previewMutation = useMutation(
    pluginBundlePreviewMutationOptions(target),
  );
  const updatePreviewMutation = useMutation(
    pluginBundleUpdatePreviewMutationOptions(target),
  );
  const [importing, setImporting] = React.useState(false);
  const runBundle: BundleRun = async (action, success) => {
    setBusy(true);
    setMessage(undefined);
    const outcome = await settle(async () => {
      await bundleMutation.mutateAsync(action);
      setMessage(success);
    });
    if (!outcome.ok) setMessage(errorMessage(outcome.error));
    setBusy(false);
    bundleMutation.reset();
    return outcome.ok;
  };
  const close = () => {
    setEditing(undefined);
    onDirtyChange(false);
  };
  const data = resource.data;
  const plugins = listedPlugins(data?.plugins ?? []);
  const canUpdate = data?.canUpdate ?? false;
  const installed = bundles.data?.items ?? [];
  const canImport = bundles.data?.canMutate ?? false;
  const editingPlugin = plugins.find(({ id }) => id === editing);
  const editingBundle = installed.find(({ id }) => id === editing);
  return (
    <div className="first-party-plugins-settings">
      <SettingsHeading
        title={
          target.scope === "workspace"
            ? "Workspace Plugins"
            : "Personal Plugins"
        }
        description={
          target.scope === "workspace"
            ? "Plugins add tools to dx Threads for everyone in this workspace. A plugin turned off here is off for every member."
            : "Plugins add tools to your dx Threads. Your choices override your workspace's, unless it turns a plugin off or manages its keys."
        }
        actions={
          <span className="first-party-plugins-heading-actions">
            <span aria-live="polite">
              {resource.isPending
                ? "Loading plugins…"
                : resource.error !== null
                  ? errorMessage(resource.error)
                  : message}
            </span>
            <OtherScopeLink
              scope={target.scope}
              workspace={workspace}
              settingsReturnTo={settingsReturnTo}
            />
            {canImport ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setImporting(true)}
              >
                Import
              </Button>
            ) : null}
          </span>
        }
      />
      {data === undefined ? null : (
        <SettingsCard>
          {plugins.length === 0 && installed.length === 0 ? (
            <p className="settings-card-empty">
              No plugins are installed on this deployment.
            </p>
          ) : (
            plugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                scope={target.scope}
                canUpdate={canUpdate}
                busy={busy}
                run={run}
                onOpenSettings={(trigger) => {
                  finalFocus.current = trigger;
                  setEditing(plugin.id);
                }}
              />
            ))
          )}
          {installed.map((bundle) => (
            <PluginBundleRow
              key={bundle.id}
              bundle={bundle}
              canMutate={canImport}
              busy={busy}
              run={runBundle}
              onOpen={(trigger) => {
                finalFocus.current = trigger;
                setEditing(bundle.id);
              }}
            />
          ))}
          {target.scope === "workspace" && plugins.length > 0 ? (
            <SettingsRow
              title="Members can use their own keys"
              control={
                <SettingsToggle
                  checked={plugins.every(
                    ({ personalOverridesAllowed }) => personalOverridesAllowed,
                  )}
                  disabled={!canUpdate || busy}
                  label="Members can use their own keys"
                  onCheckedChange={(value) =>
                    void run(
                      { type: "policy", allowPersonalOverrides: value },
                      "Workspace plugin policy updated.",
                    )
                  }
                />
              }
            />
          ) : null}
        </SettingsCard>
      )}
      <ImportPluginDialog
        open={importing}
        busy={busy}
        preview={(upload) => previewMutation.mutateAsync(upload)}
        run={runBundle}
        onClose={() => setImporting(false)}
      />
      <DialogRoot
        open={editingBundle !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {editingBundle === undefined ? null : (
          <DialogContent
            finalFocus={finalFocus}
            className="plugin-bundle-dialog"
          >
            <PluginBundleDetails
              bundle={editingBundle}
              canMutate={canImport}
              busy={busy}
              run={runBundle}
              previewUpdate={(file) =>
                updatePreviewMutation.mutateAsync({
                  pluginId: editingBundle.id,
                  ...(file === undefined ? {} : { file }),
                })
              }
              workspace={workspace}
              settingsReturnTo={settingsReturnTo}
              onDone={close}
              key={editingBundle.id}
            />
          </DialogContent>
        )}
      </DialogRoot>
      <DialogRoot
        open={editingPlugin !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {editingPlugin === undefined ? null : (
          <DialogContent
            finalFocus={finalFocus}
            className="first-party-plugin-dialog"
          >
            <DialogTitle>{editingPlugin.displayName}</DialogTitle>
            <PluginSettingsForm
              key={editingPlugin.id}
              plugin={editingPlugin}
              scope={target.scope}
              canUpdate={canUpdate}
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
