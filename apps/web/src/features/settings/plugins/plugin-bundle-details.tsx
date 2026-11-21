import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { settle } from "../../../shared/settle.js";
import { lazyComponent } from "../../../shared/stale-chunk.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import { PluginIcon } from "../../../shared/ui/plugin-icon.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { PluginBundleHotReload } from "./plugin-bundle-hot-reload.js";
import { BundleItems } from "./plugin-bundle-items.js";
import { McpSettingsLink } from "./plugin-bundle-mcp-link.js";
import { pluginBundleSignedExportMutationOptions } from "./plugin-bundle-mutations.js";
import { type BundleRun, errorMessage } from "./plugin-bundle-presentation.js";
import { PluginBundleRemove } from "./plugin-bundle-remove.js";
import { PluginBundleSettingsForm } from "./plugin-bundle-settings-form.js";
import { PluginBundleShare } from "./plugin-bundle-share.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";
import { PluginBundleUpdate } from "./plugin-bundle-update.js";
import { PluginJobs } from "./plugin-jobs.js";

/** The host cost line loads with the details, never with the page. */
const PluginBundleHostCost = lazyComponent(() =>
  import("./plugin-bundle-host-cost.js").then((module) => ({
    default: module.PluginBundleHostCost,
  })),
);

export function PluginBundleDetails({
  bundle,
  canMutate,
  busy,
  run,
  previewUpdate,
  workspace,
  settingsReturnTo,
  initialUpdate,
  hotReloadThreadId,
  onDone,
}: Pick<SettingsSectionProps, "workspace" | "settingsReturnTo"> & {
  /** From a `dxd plugin dev` link: the Thread hot reload would be on for. */
  readonly hotReloadThreadId?: string | undefined;
  /** Opens on this update's review, from the row's Update. */
  readonly initialUpdate?: PluginBundleUpdatePreviewData | undefined;
  readonly bundle: PluginBundleData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  /** Reads the plugin's source again; `file` is a new ZIP. */
  readonly previewUpdate: (
    file?: File,
  ) => Promise<PluginBundleUpdatePreviewData>;
  readonly onDone: () => void;
}) {
  // Where its settings, jobs, and costs live; a workspace plugin has none
  // outside its workspace.
  const target: PluginsTarget | undefined =
    bundle.scope === "personal"
      ? { scope: "personal" }
      : workspace === undefined
        ? undefined
        : { scope: "workspace", workspaceSlug: workspace.shortName as never };
  const [update, setUpdate] = React.useState<
    | {
        readonly data: PluginBundleUpdatePreviewData;
        readonly file?: File;
      }
    | undefined
  >(initialUpdate === undefined ? undefined : { data: initialUpdate });
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const fileInput = React.useRef<HTMLInputElement>(null);
  // A plain download: the browser saves the route's ZIP with the session.
  const exportHref = `${
    bundle.scope === "workspace" && workspace !== undefined
      ? `/v1/settings/workspaces/${encodeURIComponent(workspace.shortName)}`
      : "/v1/settings/personal"
  }/plugin-bundles/${encodeURIComponent(bundle.id)}/export`;
  const signedExport = useMutation(
    pluginBundleSignedExportMutationOptions(exportHref, `${bundle.name}.zip`),
  );
  const signing = signedExport.isPending;
  /** Downloads the export with plugin.sig; a refusal shows its reason. */
  const exportSigned = () => {
    setError(undefined);
    signedExport.mutate(undefined, {
      onError: (failure) => setError(errorMessage(failure)),
    });
  };
  const check = async (file?: File) => {
    setError(undefined);
    setChecking(true);
    const outcome = await settle(() => previewUpdate(file));
    setChecking(false);
    if (outcome.ok)
      setUpdate({
        data: outcome.value,
        ...(file === undefined ? {} : { file }),
      });
    else setError(errorMessage(outcome.error));
  };
  if (update !== undefined) {
    return (
      <PluginBundleUpdate
        bundle={bundle}
        update={update.data}
        {...(update.file === undefined ? {} : { file: update.file })}
        busy={busy}
        run={run}
        onBack={() => setUpdate(undefined)}
        onDone={onDone}
      />
    );
  }
  return (
    <div className="plugin-bundle-form">
      <header>
        <PluginIcon
          name={bundle.displayName}
          icon={bundle.iconSet}
          legacySrc={bundle.icon}
          size={64}
          className="plugin-bundle-header-icon"
        />
        <DialogTitle>{bundle.displayName}</DialogTitle>
        <PluginBundleSourceLine
          source={bundle.source}
          version={bundle.version}
          signature={bundle.signature}
        />
        {bundle.description === "" ? null : (
          <DialogDescription className="plugin-bundle-description">
            {bundle.description}
          </DialogDescription>
        )}
      </header>
      <BundleItems
        skills={bundle.skills}
        mcpServers={[...bundle.mcpServers, ...bundle.localMcpServers]}
        code={bundle.code}
        trust={bundle.trust}
        dev={bundle.dev}
        skipped={bundle.skipped}
      />
      {target === undefined ? null : (
        <React.Suspense fallback={null}>
          <PluginBundleHostCost bundle={bundle} target={target} />
        </React.Suspense>
      )}
      {bundle.scope === "personal" &&
      bundle.code !== undefined &&
      bundle.source.type === "zip" ? (
        <PluginBundleHotReload
          bundle={bundle}
          canMutate={canMutate}
          busy={busy}
          run={run}
          hotReloadThreadId={hotReloadThreadId}
        />
      ) : null}
      {(bundle.code?.settings.length ?? 0) === 0 ||
      target === undefined ? null : (
        <PluginBundleSettingsForm
          target={target}
          pluginId={bundle.id}
          canMutate={canMutate}
        />
      )}
      {/* Background jobs from the durable host. */}
      {(bundle.code?.jobs?.length ?? 0) === 0 || target === undefined ? null : (
        <PluginJobs
          target={target}
          pluginId={bundle.id}
          plugin={{
            name: bundle.displayName,
            icon: bundle.iconSet,
            legacySrc: bundle.icon,
          }}
          declaredJobs={bundle.code?.jobs ?? []}
        />
      )}
      {canMutate && target !== undefined ? (
        <PluginBundleShare bundle={bundle} target={target} />
      ) : null}
      {error === undefined ? null : (
        <p className="plugin-bundle-error" role="alert">
          {error}
        </p>
      )}
      <input
        ref={fileInput}
        className="skill-file-input"
        type="file"
        aria-label="Choose the plugin's new ZIP"
        accept=".zip,application/zip"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) void check(file);
        }}
      />
      <footer className="plugin-bundle-actions">
        {canMutate ? (
          <PluginBundleRemove
            bundle={bundle}
            busy={busy}
            run={run}
            onDone={onDone}
          />
        ) : null}
        {canMutate ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || checking}
            onClick={() =>
              bundle.source.type === "zip"
                ? fileInput.current?.click()
                : void check()
            }
          >
            {checking
              ? "Checking…"
              : bundle.source.type === "zip"
                ? "Upload new ZIP"
                : "Check for updates"}
          </Button>
        ) : null}
        <a
          className={buttonVariants({ variant: "outline", size: "xs" })}
          href={exportHref}
          download={`${bundle.name}.zip`}
        >
          Export ZIP
        </a>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || signing}
          title="Export with plugin.sig, signed with your dx key from Signing Keys"
          onClick={exportSigned}
        >
          {signing ? "Signing…" : "Export signed"}
        </Button>
        {bundle.mcpServers.some(({ reviewed }) => !reviewed) ? (
          <McpSettingsLink
            workspace={workspace}
            scope={bundle.scope}
            settingsReturnTo={settingsReturnTo}
          />
        ) : null}
        <Button size="xs" onClick={onDone}>
          Done
        </Button>
      </footer>
    </div>
  );
}
