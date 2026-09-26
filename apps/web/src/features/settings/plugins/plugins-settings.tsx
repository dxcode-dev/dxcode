import {
  type EnvironmentVariableConfigReference,
  MAX_PLUGIN_FILE_BYTES,
  MAX_PLUGIN_FILES,
  MAX_PLUGIN_TOTAL_BYTES,
  type PluginGrantedPermissions,
  type PluginImportBundle,
  type PluginVersion,
  pluginPermissionsEmpty,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, Plus, RefreshCw, Trash2 } from "lucide-react";
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
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  type PluginPreview,
  type PluginsMutationAction,
  pluginPreviewMutationOptions,
  pluginsMutationOptions,
} from "./plugins-mutations.js";
import {
  type EnvironmentVariableData,
  type PluginData,
  type PluginsTarget,
  pluginsQueryOptions,
} from "./plugins-queries.js";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";
const permissionKeys = [
  "tools",
  "commands",
  "lifecycle",
  "triggers",
  "uiSurfaces",
  "networkDestinations",
  "filesystem",
  "mcpServerIds",
  "agentCapabilities",
] as const;
type PermissionKey = (typeof permissionKeys)[number];
const permissionLabel: Record<PermissionKey, string> = {
  tools: "Tools",
  commands: "Commands",
  lifecycle: "Lifecycle hooks",
  triggers: "Triggers",
  uiSurfaces: "UI metadata",
  networkDestinations: "Network destinations",
  filesystem: "Filesystem",
  mcpServerIds: "MCP servers",
  agentCapabilities: "Agent capabilities",
};

const stateLabel = (state: PluginData["effectiveState"]) =>
  ({
    disabled: "Disabled",
    effective: "Effective",
    "blocked-by-workspace": "Overridden by workspace",
    "blocked-by-policy": "Blocked by workspace policy",
  })[state];

const browserBundle = async (
  list: ReadonlyArray<File>,
): Promise<PluginImportBundle> => {
  if (list.length < 2 || list.length > MAX_PLUGIN_FILES)
    throw new Error(
      `Select plugin.json and 1–${MAX_PLUGIN_FILES - 1} source files.`,
    );
  let total = 0;
  const files = await Promise.all(
    list.map(async (file) => {
      if (file.size > MAX_PLUGIN_FILE_BYTES)
        throw new Error(
          `${file.name} exceeds ${MAX_PLUGIN_FILE_BYTES.toLocaleString()} bytes.`,
        );
      total += file.size;
      const parts = (file.webkitRelativePath || file.name).split("/");
      return {
        path: parts.length > 1 ? parts.slice(1).join("/") : file.name,
        kind: "file" as const,
        mediaType: file.type || "text/plain",
        encoding: "utf-8" as const,
        content: await file.text(),
      };
    }),
  );
  if (total > MAX_PLUGIN_TOTAL_BYTES)
    throw new Error(
      `Selection exceeds ${MAX_PLUGIN_TOTAL_BYTES.toLocaleString()} bytes.`,
    );
  if (!files.some(({ path }) => path === "plugin.json"))
    throw new Error(
      "The selected folder must contain plugin.json at its root.",
    );
  return {
    source: { type: "browser-files", label: "Reviewed browser file selection" },
    files,
  };
};

type Preview = PluginPreview;
function ReviewDialog({
  preview,
  bundle,
  busy,
  updating,
  onClose,
  onTrust,
  secrets,
}: {
  readonly preview: Preview;
  readonly bundle: PluginImportBundle;
  readonly busy: boolean;
  readonly updating?: PluginData;
  readonly onClose: () => void;
  readonly onTrust: (grants: PluginGrantedPermissions) => void;
  readonly secrets: ReadonlyArray<EnvironmentVariableData>;
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [secretReferences, setSecretReferences] = React.useState<
    Readonly<Record<string, EnvironmentVariableConfigReference>>
  >({});
  const requested = preview.manifest.permissions;
  const toggle = (key: PermissionKey, value: string) =>
    setSelected((current) => {
      const next = new Set(current);
      const id = `${key}:${value}`;
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const grants = (): PluginGrantedPermissions => {
    const empty = pluginPermissionsEmpty();
    return {
      ...empty,
      ...Object.fromEntries(
        permissionKeys.map((key) => [
          key,
          requested[key].filter((value) => selected.has(`${key}:${value}`)),
        ]),
      ),
      secretReferences: requested.secretNames.flatMap((name) => {
        const reference = secretReferences[name];
        return reference === undefined ? [] : [{ name, reference }];
      }),
    } as PluginGrantedPermissions;
  };
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="skill-review-dialog">
        <DialogTitle>
          Review and trust {preview.manifest.displayName}
        </DialogTitle>
        <DialogDescription>
          Nothing is installed until you inspect this exact version and
          explicitly trust it. Requested permissions are denied unless checked
          below. Trusting requires recent password verification from Security.
        </DialogDescription>
        <div className="skill-review">
          <div className="skill-badges">
            <Badge>v{preview.manifest.version}</Badge>
            <Badge>{preview.totalBytes.toLocaleString()} bytes</Badge>
            <Badge>{preview.files.length} files</Badge>
          </div>
          <details open>
            <summary>Validated plain-text manifest</summary>
            <pre>{JSON.stringify(preview.manifest, null, 2)}</pre>
          </details>
          <details open>
            <summary>Exact source files</summary>
            {bundle.files.map((file) => (
              <section key={file.path}>
                <strong>
                  <code>{file.path}</code>
                </strong>
                <pre>{file.content}</pre>
              </section>
            ))}
          </details>
          <details open>
            <summary>Requested vs explicitly granted permissions</summary>
            {permissionKeys.map((key) => (
              <fieldset key={key}>
                <legend>{permissionLabel[key]}</legend>
                {requested[key].length === 0 ? (
                  <span>Not requested</span>
                ) : (
                  requested[key].map((value) => (
                    <label key={String(value)} className="plugin-permission">
                      <input
                        type="checkbox"
                        checked={selected.has(`${key}:${value}`)}
                        onChange={() => toggle(key, String(value))}
                      />{" "}
                      requested: <code>{String(value)}</code> —{" "}
                      {selected.has(`${key}:${value}`)
                        ? "explicitly granted"
                        : "denied"}
                    </label>
                  ))
                )}
              </fieldset>
            ))}
            <fieldset>
              <legend>Secrets</legend>
              {requested.secretNames.length ? (
                requested.secretNames.map((name) => {
                  const candidates = secrets.filter(
                    (secret) =>
                      secret.kind === "secret" &&
                      secret.enabled &&
                      String(secret.name) === String(name),
                  );
                  return (
                    <div key={name} className="plugin-permission">
                      Requested: <code>{name}</code>
                      <SettingsSelect
                        label={`Secret reference for ${name}`}
                        value={secretReferences[name]?.id ?? ""}
                        options={[
                          ["", "Denied"],
                          ...candidates.map(
                            (secret) =>
                              [
                                secret.reference.id,
                                `${secret.name} · ${secret.source}`,
                              ] as const,
                          ),
                        ]}
                        onValueChange={(id) =>
                          setSecretReferences((current) => {
                            const next = { ...current };
                            const reference = candidates.find(
                              (secret) => secret.reference.id === id,
                            )?.reference;
                            if (reference === undefined) delete next[name];
                            else next[name] = reference;
                            return next;
                          })
                        }
                      />
                      {candidates.length === 0
                        ? " No enabled secret with this exact name exists in this scope."
                        : null}
                    </div>
                  );
                })
              ) : (
                <span>Not requested</span>
              )}
            </fieldset>
          </details>
          <p>
            <strong>Bundle integrity:</strong> <code>{preview.integrity}</code>
          </p>
          <div className="skill-actions">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => onTrust(grants())}>
              {busy
                ? "Trusting…"
                : updating
                  ? "Trust and activate update"
                  : "Trust exact plugin"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function PluginCard({
  plugin,
  disabled,
  run,
  update,
}: {
  readonly plugin: PluginData;
  readonly disabled: boolean;
  readonly run: (action: PluginsMutationAction, message: string) => void;
  readonly update: (plugin: PluginData) => void;
}) {
  const [removeOpen, setRemoveOpen] = React.useState(false);
  return (
    <>
      <article className="skill-card">
        <header>
          <div>
            <h2>{plugin.active.manifest.displayName}</h2>
            <p>{plugin.active.manifest.description}</p>
          </div>
          <SettingsToggle
            checked={plugin.enabled}
            disabled={disabled}
            label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
            onCheckedChange={(enabled) =>
              run(
                {
                  type: "updateState",
                  pluginId: plugin.id,
                  input: { enabled },
                },
                "Plugin state updated.",
              )
            }
          />
        </header>
        <div className="skill-badges">
          <Badge>{plugin.scope}</Badge>
          <Badge>{plugin.enabled ? "Enabled" : "Disabled"}</Badge>
          <Badge>{stateLabel(plugin.effectiveState)}</Badge>
          <Badge>Health: {plugin.healthStatus}</Badge>
          <Badge>v{plugin.activeVersion}</Badge>
          <Badge>{plugin.active.source.type}</Badge>
          <Badge>{plugin.active.trusted ? "Trusted" : "Untrusted"}</Badge>
          {plugin.overridesPersonal ? <Badge>Overrides personal</Badge> : null}
        </div>
        <details>
          <summary>Manifest, files, grants, and integrity</summary>
          <pre>{JSON.stringify(plugin.active.manifest, null, 2)}</pre>
          <pre>{JSON.stringify(plugin.active.grants, null, 2)}</pre>
          <ul>
            {plugin.active.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code> · {file.sizeBytes.toLocaleString()}{" "}
                bytes · <code>{file.integrity}</code>
              </li>
            ))}
          </ul>
          <p>
            <strong>Integrity:</strong> <code>{plugin.active.integrity}</code>
          </p>
        </details>
        <SettingsSelect
          label={`Active version for ${plugin.name}`}
          value={plugin.activeVersion}
          disabled={disabled || plugin.versions.length < 2}
          options={plugin.versions.map((version) => [
            version,
            `Version ${version}`,
          ])}
          onValueChange={(version) =>
            run(
              {
                type: "updateState",
                pluginId: plugin.id,
                input: { activeVersion: version as PluginVersion },
              },
              "Plugin rolled back.",
            )
          }
        />
        <div className="skill-actions">
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => update(plugin)}
          >
            <RefreshCw /> Update
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => setRemoveOpen(true)}
          >
            <Trash2 /> Remove
          </Button>
        </div>
      </article>
      <DialogRoot open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="skill-review-dialog">
          <DialogTitle>
            Remove {plugin.active.manifest.displayName}?
          </DialogTitle>
          <DialogDescription>
            This immediately disables the plugin and removes it from this
            settings scope. Its immutable versions and payload-free invocation
            audit remain retained.
          </DialogDescription>
          <div className="skill-actions">
            <Button variant="ghost" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={disabled}
              onClick={() => {
                setRemoveOpen(false);
                run({ type: "remove", pluginId: plugin.id }, "Plugin removed.");
              }}
            >
              Remove plugin
            </Button>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

export function PluginsSettings({ workspaceSlug }: SettingsSectionProps) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const target = React.useMemo<PluginsTarget>(
    () =>
      workspaceSlug === undefined
        ? { scope: "personal" }
        : { scope: "workspace", workspaceSlug },
    [workspaceSlug],
  );
  const resource = useQuery(pluginsQueryOptions(identity.id, target));
  const environment = useQuery(
    environmentVariablesQueryOptions(identity.id, target),
  );
  const mutation = useMutation(
    pluginsMutationOptions(queryClient, identity.id, target),
  );
  const previewMutation = useMutation(
    pluginPreviewMutationOptions(identity.id, target),
  );
  const [review, setReview] = React.useState<{
    preview: Preview;
    bundle: PluginImportBundle;
    updating?: PluginData;
  }>();
  const [updating, setUpdating] = React.useState<PluginData>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const input = React.useRef<HTMLInputElement>(null);
  const run = async (action: PluginsMutationAction, success: string) => {
    setBusy(true);
    setMessage(undefined);
    try {
      await mutation.mutateAsync(action);
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
      mutation.reset();
    }
  };
  const select = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    try {
      const bundle = await browserBundle(files);
      setReview({
        preview: await previewMutation.mutateAsync(bundle),
        bundle,
        updating,
      });
    } catch (error) {
      setMessage(errorMessage(error));
      setUpdating(undefined);
    } finally {
      previewMutation.reset();
    }
  };
  const choose = (plugin?: PluginData) => {
    setUpdating(plugin);
    input.current?.click();
  };
  const canMutate = resource.data?.canMutate ?? false;
  return (
    <div className="skills-settings">
      <SettingsHeading
        title={
          target.scope === "workspace"
            ? "Workspace Plugins"
            : "Personal Plugins"
        }
        description="Install only bounded browser files after an exact first-party review. Marketplace and prompt-driven installs are not supported."
      />
      {target.scope === "workspace" &&
      resource.data?.allowPersonalPlugins !== undefined ? (
        <SettingsCard title="Workspace policy">
          <div className="skill-policy">
            <div>
              <strong>Allow personal plugins</strong>
              <p>Admins can block all personal plugins in this workspace.</p>
            </div>
            <SettingsToggle
              checked={resource.data.allowPersonalPlugins}
              disabled={!canMutate || busy}
              label="Allow personal plugins"
              onCheckedChange={(value) =>
                void run(
                  { type: "updatePolicy", allowPersonalPlugins: value },
                  "Workspace plugin policy updated.",
                )
              }
            />
          </div>
        </SettingsCard>
      ) : null}
      <SettingsCard title="Trusted plugins">
        <div className="skill-toolbar">
          <p>
            Plugin UI and command declarations are displayed only as validated
            plain manifest text.
          </p>
          <Button disabled={!canMutate || busy} onClick={() => choose()}>
            <Plus /> Import folder
          </Button>
        </div>
        <input
          ref={input}
          className="skill-file-input"
          type="file"
          multiple
          {...({ webkitdirectory: "" } as Record<string, string>)}
          accept=".json,.js,.mjs,.txt,text/*,application/json"
          aria-label="Select plugin folder"
          onChange={(event) => void select(event)}
        />
        <p className="skill-file-help">
          <FileCode2 /> Select a bounded folder containing root{" "}
          <code>plugin.json</code> and source files. A server preview is
          mandatory before trust.
        </p>
        <div aria-live="polite" className="skill-message">
          {resource.isPending || environment.isPending
            ? "Loading plugins…"
            : ((resource.error === null
                ? undefined
                : errorMessage(resource.error)) ??
              (environment.error === null
                ? undefined
                : errorMessage(environment.error)) ??
              message)}
        </div>
        <div className="skill-grid">
          {resource.data?.items.length === 0 && !resource.isPending ? (
            <p>No trusted plugins in this scope.</p>
          ) : null}
          {resource.data?.items.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              disabled={!canMutate || busy}
              run={(action, notice) => void run(action, notice)}
              update={choose}
            />
          ))}
        </div>
      </SettingsCard>
      {review ? (
        <ReviewDialog
          {...review}
          busy={busy}
          secrets={environment.data?.items ?? []}
          onClose={() => {
            setReview(undefined);
            setUpdating(undefined);
          }}
          onTrust={(grants) =>
            void run(
              review.updating
                ? {
                    type: "publishVersion",
                    pluginId: review.updating.id,
                    bundle: review.bundle,
                    reviewedIntegrity: review.preview.integrity,
                    grants,
                  }
                : {
                    type: "trust",
                    bundle: review.bundle,
                    reviewedIntegrity: review.preview.integrity,
                    grants,
                  },
              review.updating
                ? "Plugin update trusted and activated."
                : "Plugin trusted.",
            ).then((ok) => {
              if (ok) {
                setReview(undefined);
                setUpdating(undefined);
              }
            })
          }
        />
      ) : null}
    </div>
  );
}
