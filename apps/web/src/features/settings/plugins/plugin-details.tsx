import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import { pluginRebuildReason } from "@dx/domain";
import type * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import {
  PackageBrowserHeader,
  PackageBrowserSection,
} from "../../../shared/ui/package-browser.js";
import { PluginIcon } from "../../../shared/ui/plugin-icon.js";
import { SettingsToggle } from "../settings-primitives.js";
import { PluginActivity } from "./plugin-activity.js";
import { PluginCapabilityList } from "./plugin-bundle-items.js";
import {
  type BundleRun,
  bundleHint,
  plural,
} from "./plugin-bundle-presentation.js";
import { PluginBundleSettingsForm } from "./plugin-bundle-settings-form.js";
import { PluginBundleShare } from "./plugin-bundle-share.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";
import { PluginBundleUpdate } from "./plugin-bundle-update.js";
import type { EditedPluginFile } from "./plugin-files-queries.js";
import { PluginRunsOn } from "./plugin-runs-on.js";

/** A dialog the details open over the page. */
export type Panel =
  | {
      readonly kind: "review";
      readonly bundle: PluginBundleData;
      readonly preview: PluginBundleUpdatePreviewData;
      /** Edited files; absent for an update from the plugin's source. */
      readonly files?: ReadonlyArray<EditedPluginFile>;
      /** The new ZIP, for a plugin uploaded as one. */
      readonly zip?: File;
    }
  | { readonly kind: "settings"; readonly bundle: PluginBundleData }
  | { readonly kind: "share"; readonly bundle: PluginBundleData };

/**
 * The chosen plugin's header: its icon and name, Update when its source has
 * a newer version, On/Off, its menu, and under them its description, source,
 * version, and a hint when it cannot work as shown.
 */
export function PluginHeader({
  bundle,
  canMutate,
  busy,
  run,
  updateAvailable,
  updating,
  onUpdate,
  menu,
}: {
  readonly bundle: PluginBundleData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  readonly updateAvailable: boolean;
  readonly updating: boolean;
  readonly onUpdate: () => void;
  readonly menu: React.ReactNode;
}) {
  const hint = bundleHint(bundle, canMutate);
  return (
    <PackageBrowserHeader
      icon={
        <PluginIcon
          name={bundle.displayName}
          icon={bundle.iconSet}
          legacySrc={bundle.icon}
          size={20}
        />
      }
      title={bundle.displayName}
      actions={
        <>
          {updateAvailable && canMutate ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || updating}
              aria-label={`Update ${bundle.displayName}`}
              onClick={onUpdate}
            >
              {updating ? "Checking…" : "Update"}
            </Button>
          ) : null}
          <span className="plugin-browser-state">
            {bundle.enabled ? "On" : "Off"}
            <SettingsToggle
              checked={bundle.enabled}
              disabled={!canMutate || busy}
              label={`Use ${bundle.displayName}`}
              onCheckedChange={(enabled) =>
                void run(
                  { type: "enabled", pluginId: bundle.id, enabled },
                  `${bundle.displayName} turned ${enabled ? "on" : "off"}.`,
                )
              }
            />
          </span>
          {menu}
        </>
      }
      description={bundle.description}
      meta={
        <>
          <PluginBundleSourceLine
            source={bundle.source}
            version={bundle.version}
            signature={bundle.signature}
          />
          {hint === undefined ? null : <Badge tone="warning">{hint}</Badge>}
        </>
      }
    />
  );
}

/**
 * Beside the files: what the plugin can do, why it does not load when it
 * must be rebuilt, what it did this month, where it runs, and its settings.
 */
export function PluginDetails({
  bundle,
  target,
  canMutate,
  reviewTools,
  onOpen,
}: {
  readonly bundle: PluginBundleData;
  readonly target: PluginsTarget;
  readonly canMutate: boolean;
  /** The link to approve its MCP servers' tools, where that is done. */
  readonly reviewTools: React.ReactNode;
  readonly onOpen: (kind: "settings") => void;
}) {
  const rebuild = pluginRebuildReason(bundle);
  const settings = bundle.code?.settings.length ?? 0;
  return (
    <>
      <PackageBrowserSection title="What it can do">
        <PluginCapabilityList
          contents={{
            code: bundle.code,
            skills: bundle.skills,
            mcpServers: [
              ...bundle.mcpServers.map(({ name, endpoint }) => ({
                name,
                endpoint,
              })),
              ...bundle.localMcpServers,
            ],
          }}
        />
        {bundle.mcpServers.some(({ reviewed }) => !reviewed)
          ? reviewTools
          : null}
        {rebuild === undefined ? null : (
          <p className="plugin-browser-limit" role="note">
            This plugin does not load. {rebuild} Ask dx in any Thread to rebuild
            it, or remove it.
          </p>
        )}
      </PackageBrowserSection>
      <PluginActivity bundle={bundle} target={target} />
      {/* M3 fills this row: where the plugin's program runs, who pays for
          its Orb time, and the estimate in money. */}
      <PluginRunsOn bundle={bundle} target={target} />
      {settings === 0 ? null : (
        <PackageBrowserSection title="Settings">
          <p>{plural(settings, "setting", "settings")} for this install.</p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onOpen("settings")}
          >
            {canMutate ? "Change settings" : "See settings"}
          </Button>
        </PackageBrowserSection>
      )}
    </>
  );
}

/** The dialog the details open: a review, settings, or sharing. */
export function PluginPanelDialog({
  panel,
  target,
  canMutate,
  busy,
  run,
  onSaveEdit,
  onClose,
}: {
  readonly panel: Panel | undefined;
  readonly target: PluginsTarget;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  /** Saves reviewed edits as the plugin's next version; true once saved. */
  readonly onSaveEdit: (
    bundle: PluginBundleData,
    files: ReadonlyArray<EditedPluginFile>,
    preview: PluginBundleUpdatePreviewData,
    acceptPermissions: boolean,
  ) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={panel !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {panel === undefined ? null : (
        <DialogContent className="plugin-bundle-dialog">
          {panel.kind === "review" ? (
            <PluginBundleUpdate
              bundle={panel.bundle}
              target={target}
              update={panel.preview}
              {...(panel.zip === undefined ? {} : { file: panel.zip })}
              busy={busy}
              run={run}
              {...(panel.files === undefined
                ? {}
                : {
                    title: `Save ${panel.bundle.displayName}`,
                    confirmLabel: "Save",
                    onApply: (acceptPermissions: boolean) =>
                      onSaveEdit(
                        panel.bundle,
                        panel.files ?? [],
                        panel.preview,
                        acceptPermissions,
                      ),
                  })}
              onBack={onClose}
              onDone={onClose}
            />
          ) : panel.kind === "settings" ? (
            <>
              <DialogTitle>{panel.bundle.displayName} settings</DialogTitle>
              <PluginBundleSettingsForm
                target={target}
                pluginId={panel.bundle.id}
                canMutate={canMutate}
              />
            </>
          ) : (
            <>
              <DialogTitle>Share {panel.bundle.displayName}</DialogTitle>
              <p className="plugin-bundle-help">
                Anyone signed in to dx who opens the link can install a copy
                that follows your updates.
              </p>
              <PluginBundleShare bundle={panel.bundle} target={target} />
            </>
          )}
        </DialogContent>
      )}
    </DialogRoot>
  );
}
