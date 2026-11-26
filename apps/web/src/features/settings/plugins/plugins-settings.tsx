import type { PluginBundleListData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Settings } from "lucide-react";
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
import { AskDxPrompt } from "../ask-dx-prompt.js";
import { MemberPolicyToggle } from "../member-policy-toggle.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  ImportPluginDialog,
  useSharedPluginLink,
} from "./import-plugin-dialog.js";
import { PluginBrowser } from "./plugin-browser.js";
import { McpSettingsLink } from "./plugin-bundle-mcp-link.js";
import {
  pluginBundlePreviewMutationOptions,
  pluginBundlesMutationOptions,
  pluginBundleUpdatePreviewMutationOptions,
} from "./plugin-bundle-mutations.js";
import type { BundleRun } from "./plugin-bundle-presentation.js";
import { pluginBundlesQueryOptions } from "./plugin-bundle-queries.js";
import { usePluginBundleQuickUpdate } from "./plugin-bundle-quick-update.js";
import { PluginProposals } from "./plugin-proposals.js";
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
  // On but unable to work: ask for the key instead of showing it on.
  const needsSetUp =
    !toggle.locked && plugin.effective.status === "no-provider";
  return (
    <div className="first-party-plugin-row">
      <span className="first-party-plugin-creator">
        <DxWordmark size="small" />
      </span>
      <strong>{plugin.displayName}</strong>
      {hint === undefined ? null : <span>{hint}</span>}
      {needsSetUp ? (
        <Button
          className="first-party-plugin-set-up"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={(event) => onOpenSettings(event.currentTarget)}
        >
          Set up
        </Button>
      ) : (
        <>
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
        </>
      )}
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

/** Where nothing is installed yet: what to do, as on Skills. */
function EmptyPlugins({
  scope,
  canImport,
  onImport,
}: {
  readonly scope: Scope;
  readonly canImport: boolean;
  readonly onImport: () => void;
}) {
  return (
    <div className="settings-card-empty ask-dx-empty">
      <p>
        {canImport
          ? `No ${scope} plugins yet. Describe one to dx in any Thread, or import one:`
          : `No ${scope} plugins yet.`}
      </p>
      {canImport ? (
        <>
          <AskDxPrompt
            text={`Create a ${scope} plugin that adds a tool to check our deploy status`}
          />
          <Button size="sm" variant="outline" onClick={onImport}>
            Import a plugin
          </Button>
        </>
      ) : null}
    </div>
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
  /** The installed plugin the browser shows. */
  const [selected, setSelected] = React.useState<string>();
  /** The dx plugin whose settings dialog is open. */
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
  const shareLink = useSharedPluginLink();
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
  const quickUpdate = usePluginBundleQuickUpdate({
    userId: identity.id,
    target,
    bundles: bundles.data?.items ?? [],
    canMutate: bundles.data?.canMutate ?? false,
    previewUpdate: (pluginId) =>
      updatePreviewMutation.mutateAsync({ pluginId }),
    run: runBundle,
    report: setMessage,
    review: setSelected,
  });
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
  const shown = installed.find(({ id }) => id === selected) ?? installed[0];
  const pendingReview =
    shown === undefined ? undefined : quickUpdate.reviewFor(shown.id);
  return (
    <div className="first-party-plugins-settings plugins-page">
      <SettingsHeading
        title={
          target.scope === "workspace"
            ? "Workspace Plugins"
            : "Personal Plugins"
        }
        description={
          target.scope === "workspace"
            ? "Plugins add tools, skills, and screens to dx for everyone in this workspace. A plugin turned off here is off for every member."
            : "Plugins add tools, skills, and screens to your dx Threads. Your choices override your workspace's, unless it turns a plugin off or manages its keys."
        }
        actions={
          <span className="first-party-plugins-heading-actions">
            <span aria-live="polite">
              {resource.isPending || bundles.isPending
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
                size="sm"
                disabled={busy}
                onClick={() => setImporting(true)}
              >
                <Plus aria-hidden="true" /> Add plugin
              </Button>
            ) : null}
          </span>
        }
      />
      <PluginProposals
        target={target}
        proposals={bundles.data?.proposals ?? []}
        report={setMessage}
      />
      {bundles.data === undefined ? null : (
        <PluginBrowser
          target={target}
          bundles={installed}
          canMutate={canImport}
          busy={busy}
          run={runBundle}
          empty={
            <EmptyPlugins
              scope={target.scope}
              canImport={canImport}
              onImport={() => setImporting(true)}
            />
          }
          selectedId={shown?.id}
          onSelect={setSelected}
          updatesAvailable={quickUpdate.available}
          updating={quickUpdate.checking}
          onUpdate={(bundle) => void quickUpdate.update(bundle)}
          review={
            shown === undefined || pendingReview === undefined
              ? undefined
              : { pluginId: shown.id, preview: pendingReview }
          }
          onReviewChange={() => quickUpdate.clearReview()}
          report={setMessage}
          reviewTools={
            <McpSettingsLink
              workspace={workspace}
              scope={target.scope}
              settingsReturnTo={settingsReturnTo}
            />
          }
        />
      )}
      {data === undefined || plugins.length === 0 ? null : (
        <section className="plugins-built-in" aria-label="Built into dx">
          <h2>Built into dx</h2>
          <SettingsCard>
            {plugins.map((plugin) => (
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
            ))}
            {target.scope === "workspace" ? (
              <SettingsRow
                title="Members can use their own keys"
                control={
                  <MemberPolicyToggle
                    checked={plugins.every(
                      ({ personalOverridesAllowed }) =>
                        personalOverridesAllowed,
                    )}
                    disabled={!canUpdate || busy}
                    label="Members can use their own keys"
                    subject="members' own keys"
                    description="Members' next plugin calls follow the new policy."
                    onConfirm={(value) =>
                      run(
                        { type: "policy", allowPersonalOverrides: value },
                        "Workspace plugin policy updated.",
                      )
                    }
                  />
                }
              />
            ) : null}
          </SettingsCard>
        </section>
      )}
      {target.scope === "workspace" && bundles.data !== undefined ? (
        <section className="plugins-built-in" aria-label="Rules for plugins">
          <h2>Rules for plugins</h2>
          <SettingsCard>
            <WorkspaceBundlePolicies
              bundles={bundles.data}
              canMutate={canImport}
              busy={busy}
              run={runBundle}
            />
          </SettingsCard>
        </section>
      ) : null}
      <ImportPluginDialog
        userId={identity.id}
        target={target}
        installedNames={new Set(installed.map(({ name }) => name))}
        open={importing}
        share={canImport ? shareLink.token : undefined}
        busy={busy}
        preview={(upload) => previewMutation.mutateAsync(upload)}
        run={runBundle}
        onClose={() => {
          setImporting(false);
          shareLink.dismiss();
        }}
      />
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

/**
 * A workspace's rules for installed plugins: members' own copies, and
 * plugins from repositories.
 */
function WorkspaceBundlePolicies({
  bundles,
  canMutate,
  busy,
  run,
}: {
  readonly bundles: PluginBundleListData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
}) {
  return (
    <>
      <SettingsRow
        title="Members can use their own copy of a plugin"
        control={
          <MemberPolicyToggle
            checked={bundles.personalOverridesAllowed === true}
            disabled={!canMutate || busy}
            label="Members can use their own copy of a plugin"
            subject="personal plugin overrides"
            description="When on, a member's own copy of a plugin this workspace installs runs instead of the workspace's, for that member only. When off, their copy is paused. The two never run together."
            onConfirm={(value) =>
              run(
                { type: "policy", allowPersonalOverrides: value },
                "Workspace plugin policy updated.",
              )
            }
          />
        }
      />
      <SettingsRow
        title="Plugins from a repository or built in a Thread"
        control={
          <MemberPolicyToggle
            checked={bundles.repositoryPluginsAllowed !== false}
            disabled={!canMutate || busy}
            label="Plugins from a repository or built in a Thread"
            subject="plugins from repositories and Threads"
            description="When on, a plugin a project's repository carries in .agents/plugins, or one an agent builds in a Thread, runs in that Thread's Orb only. An installed plugin of the same name is used instead. When off, neither runs."
            onConfirm={(value) =>
              run(
                { type: "policy", allowRepositoryPlugins: value },
                "Workspace plugin policy updated.",
              )
            }
          />
        }
      />
    </>
  );
}
