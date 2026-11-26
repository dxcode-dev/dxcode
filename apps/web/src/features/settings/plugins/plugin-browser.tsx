import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import type { PluginId } from "@dx/domain";
import { pluginRebuildReason } from "@dx/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { FileView } from "../../../shared/ui/file-view.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { PackageBrowser } from "../../../shared/ui/package-browser.js";
import { PluginIcon } from "../../../shared/ui/plugin-icon.js";
import { pluginBundleSignedExportMutationOptions } from "./plugin-bundle-mutations.js";
import { type BundleRun, errorMessage } from "./plugin-bundle-presentation.js";
import { pluginBundlesBase } from "./plugin-bundle-queries.js";
import { removalSummary } from "./plugin-bundle-removal.js";
import {
  pluginFileQueryOptions,
  pluginFilesQueryOptions,
} from "./plugin-files-queries.js";
import "./plugins.css";
import {
  type Panel,
  PluginDetails,
  PluginHeader,
  PluginPanelDialog,
} from "./plugin-details.js";
import { usePluginVersions } from "./plugin-versions.js";

/** The file a plugin opens on: its README, else its manifest. */
const firstFile = (paths: ReadonlyArray<string>) =>
  paths.find((path) => /^readme\.md$/i.test(path)) ??
  paths.find((path) => path === "plugin.json") ??
  paths[0];

const kilobytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

const lines = (content: string) => {
  const count = content.replace(/\n$/, "").split("\n").length;
  return `${count} ${count === 1 ? "line" : "lines"}`;
};

/** Why a plugin's files can't be edited here, or undefined when they can. */
const readOnlyReason = (bundle: PluginBundleData, canMutate: boolean) =>
  !canMutate
    ? bundle.scope === "workspace"
      ? "Only workspace admins can change this plugin."
      : undefined
    : bundle.source.type === "github"
      ? "This plugin comes from GitHub. Change it there, then check for updates."
      : bundle.source.type === "share"
        ? "This plugin is a copy of a shared plugin. It changes when the person who shared it updates it."
        : undefined;

/** The open file: read from dx when a person opens it. */
function OpenFile({
  target,
  bundle,
  path,
  readOnly,
  onSave,
}: {
  readonly target: PluginsTarget;
  readonly bundle: PluginBundleData;
  readonly path: string | undefined;
  readonly readOnly: string | undefined;
  readonly onSave: ((content: string) => Promise<unknown>) | undefined;
}) {
  const file = useQuery({
    ...pluginFileQueryOptions(
      target,
      bundle.id as PluginId,
      bundle.integrity,
      path ?? "",
    ),
    enabled: path !== undefined,
  });
  if (path === undefined) return null;
  if (file.data === undefined)
    return (
      <EmptyState
        title={file.isError ? errorMessage(file.error) : "Loading…"}
        busy={file.isPending}
        tone={file.isError ? "error" : undefined}
        action={
          file.isError ? (
            <Button size="sm" variant="outline" onClick={() => file.refetch()}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <FileView
      key={`${bundle.id}-${bundle.integrity}-${path}`}
      path={path}
      content={file.data}
      detail={lines(file.data)}
      {...(onSave === undefined ? {} : { onSave })}
      {...(readOnly === undefined
        ? {}
        : {
            actions: (
              <span className="plugin-file-read-only" title={readOnly}>
                Read only
              </span>
            ),
          })}
    />
  );
}

/** Saves the route's ZIP: a plain download, with the session's cookie. */
const download = (href: string, filename: string) => {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
};

/** The plugin's menu: updates, sharing, export, and Remove. */
function PluginMenu({
  bundle,
  canMutate,
  busy,
  exportHref,
  checking,
  onCheckUpdate,
  onUploadZip,
  onShare,
  onRemove,
  onError,
}: {
  readonly bundle: PluginBundleData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly exportHref: string;
  readonly checking: boolean;
  readonly onCheckUpdate: () => void;
  readonly onUploadZip: () => void;
  readonly onShare: () => void;
  readonly onRemove: () => void;
  readonly onError: (message: string) => void;
}) {
  const signedExport = useMutation(
    pluginBundleSignedExportMutationOptions(exportHref, `${bundle.name}.zip`),
  );
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`More for ${bundle.displayName}`}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end">
        {canMutate ? (
          bundle.source.type === "zip" ? (
            <MenuItem disabled={busy || checking} onClick={onUploadZip}>
              Upload a new version
            </MenuItem>
          ) : (
            <MenuItem disabled={busy || checking} onClick={onCheckUpdate}>
              {checking ? "Checking…" : "Check for updates"}
            </MenuItem>
          )
        ) : null}
        {canMutate ? <MenuItem onClick={onShare}>Share…</MenuItem> : null}
        <MenuItem onClick={() => download(exportHref, `${bundle.name}.zip`)}>
          Download ZIP
        </MenuItem>
        <MenuItem
          disabled={signedExport.isPending}
          onClick={() =>
            signedExport.mutate(undefined, {
              onError: (failure) => onError(errorMessage(failure)),
            })
          }
        >
          {signedExport.isPending ? "Signing…" : "Download signed ZIP"}
        </MenuItem>
        {canMutate ? (
          <>
            <MenuSeparator />
            <MenuItem tone="danger" disabled={busy} onClick={onRemove}>
              Remove
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </MenuRoot>
  );
}

/**
 * Installed plugins in the package browser, as the Skills page shows
 * skills: the list, the chosen plugin's files, and the open file with
 * Edit. Beside the file: what the plugin is, what it can do, what it did
 * this month, and where it runs. Saving an edited file makes the plugin's
 * next version: at once for a personal plugin that asks for nothing new,
 * after a review otherwise.
 */
export function PluginBrowser({
  target,
  bundles,
  canMutate,
  busy,
  run,
  empty,
  selectedId,
  onSelect,
  updatesAvailable,
  updating,
  onUpdate,
  review,
  onReviewChange,
  report,
  reviewTools,
}: {
  /** The link to approve its MCP servers' tools, where that is done. */
  readonly reviewTools: React.ReactNode;
  readonly target: PluginsTarget;
  readonly bundles: ReadonlyArray<PluginBundleData>;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  readonly empty: React.ReactNode;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
  /** Plugins whose source has a newer version. */
  readonly updatesAvailable: ReadonlySet<string>;
  /** The plugin whose update is being read. */
  readonly updating: string | undefined;
  /** Updates at once when the new version asks for nothing new. */
  readonly onUpdate: (bundle: PluginBundleData) => void;
  /** An update review the page opened, such as the row's quick update. */
  readonly review:
    | {
        readonly pluginId: string;
        readonly preview: PluginBundleUpdatePreviewData;
      }
    | undefined;
  readonly onReviewChange: (review: undefined) => void;
  readonly report: (message: string | undefined) => void;
}) {
  const [openPaths, setOpenPaths] = React.useState<Record<string, string>>({});
  const [panel, setPanel] = React.useState<Panel>();
  const [removing, setRemoving] = React.useState<PluginBundleData>();
  const zipInput = React.useRef<HTMLInputElement>(null);
  const bundle = bundles.find(({ id }) => id === selectedId) ?? bundles[0];
  const files = useQuery({
    ...pluginFilesQueryOptions(
      target,
      (bundle?.id ?? "") as PluginId,
      bundle?.integrity ?? "",
    ),
    enabled: bundle !== undefined,
  });
  const paths = (files.data?.files ?? []).map(({ path }) => path);
  const openPath =
    bundle === undefined
      ? undefined
      : (openPaths[bundle.id] ?? firstFile(paths));
  const openFile = files.data?.files.find(({ path }) => path === openPath);
  const readOnly =
    bundle === undefined ? undefined : readOnlyReason(bundle, canMutate);
  const exportHref = `${pluginBundlesBase(target)}/${encodeURIComponent(bundle?.id ?? "")}/export`;
  const reviewed =
    review === undefined
      ? undefined
      : bundles.find(({ id }) => id === review.pluginId);
  const shownReview: Panel | undefined =
    panel ??
    (review === undefined || reviewed === undefined
      ? undefined
      : { kind: "review", bundle: reviewed, preview: review.preview });
  const closePanel = () => {
    setPanel(undefined);
    onReviewChange(undefined);
  };
  const { saveEdit, saveReviewed, checkUpdate, checking, saving } =
    usePluginVersions(target, report, setPanel);

  return (
    <>
      <PackageBrowser
        className="plugin-browser"
        noun="plugins"
        items={bundles.map((item) => ({
          id: item.id,
          name: item.displayName,
          icon: (
            <PluginIcon
              name={item.displayName}
              icon={item.iconSet}
              legacySrc={item.icon}
              size={16}
            />
          ),
          ...(pluginRebuildReason(item) !== undefined
            ? { hint: "Rebuild" }
            : item.enabled
              ? {}
              : { hint: "Off" }),
        }))}
        selectedId={bundle?.id}
        onSelect={onSelect}
        empty={empty}
        files={
          bundle === undefined || files.data === undefined
            ? undefined
            : {
                label: `${bundle.displayName} files`,
                paths,
                selectedPath: openPath ?? "",
                onSelect: (path) =>
                  setOpenPaths((current) => ({
                    ...current,
                    [bundle.id]: path,
                  })),
                version: `${bundle.id}-${bundle.integrity}`,
              }
        }
        filesNote={
          files.isError ? "Its files could not be read." : "Loading files…"
        }
        header={
          bundle === undefined ? null : (
            <PluginHeader
              bundle={bundle}
              canMutate={canMutate}
              busy={busy}
              run={run}
              updateAvailable={updatesAvailable.has(bundle.id)}
              updating={updating === bundle.id}
              onUpdate={() => onUpdate(bundle)}
              menu={
                <PluginMenu
                  bundle={bundle}
                  canMutate={canMutate}
                  busy={busy}
                  exportHref={exportHref}
                  checking={checking}
                  onCheckUpdate={() => void checkUpdate(bundle)}
                  onUploadZip={() => zipInput.current?.click()}
                  onShare={() => setPanel({ kind: "share", bundle })}
                  onRemove={() => setRemoving(bundle)}
                  onError={report}
                />
              }
            />
          )
        }
        aside={
          bundle === undefined ? undefined : (
            <PluginDetails
              bundle={bundle}
              target={target}
              canMutate={canMutate}
              reviewTools={reviewTools}
              onOpen={(kind) => setPanel({ kind, bundle })}
            />
          )
        }
      >
        {bundle === undefined ? null : openFile !== undefined &&
          !openFile.text ? (
          <EmptyState
            title={`${openFile.path} is not a text file`}
            description={kilobytes(openFile.bytes)}
          />
        ) : (
          <OpenFile
            target={target}
            bundle={bundle}
            path={files.data === undefined ? undefined : openPath}
            readOnly={readOnly}
            onSave={
              readOnly !== undefined || !canMutate || openPath === undefined
                ? undefined
                : (content) => saveEdit(bundle, [{ path: openPath, content }])
            }
          />
        )}
      </PackageBrowser>
      <input
        ref={zipInput}
        className="skill-file-input"
        type="file"
        aria-label="Choose the plugin's new ZIP"
        accept=".zip,application/zip"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined && bundle !== undefined)
            void checkUpdate(bundle, file);
        }}
      />
      <PluginPanelDialog
        panel={shownReview}
        target={target}
        canMutate={canMutate}
        busy={busy || saving}
        run={run}
        onSaveEdit={saveReviewed}
        onClose={closePanel}
      />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={`Remove ${removing?.displayName ?? "this plugin"}?`}
        description={
          removing === undefined || removalSummary(removing) === ""
            ? "New Threads stop loading it."
            : `This also removes its ${removalSummary(removing)}. New Threads stop loading them.`
        }
        confirmLabel={busy ? "Removing…" : "Remove"}
        destructive
        pending={busy}
        onConfirm={async () => {
          if (removing === undefined) return;
          const removed = await run(
            { type: "remove", pluginId: removing.id as PluginId },
            `${removing.displayName} removed.`,
          );
          if (removed) setRemoving(undefined);
        }}
      />
    </>
  );
}
