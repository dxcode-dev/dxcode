import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { BundleItems } from "./plugin-bundle-items.js";
import { McpSettingsLink } from "./plugin-bundle-mcp-link.js";
import { pluginBundleSignedExportMutationOptions } from "./plugin-bundle-mutations.js";
import {
  type BundleRun,
  errorMessage,
  plural,
} from "./plugin-bundle-presentation.js";
import { PluginBundleSettingsForm } from "./plugin-bundle-settings-form.js";
import { PluginBundleShare } from "./plugin-bundle-share.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";
import { PluginBundleUpdate } from "./plugin-bundle-update.js";

/** What removing a bundle also removes, for the confirmation. */
const removalSummary = (bundle: PluginBundleData) =>
  [
    bundle.skills.length > 0
      ? plural(bundle.skills.length, "skill", "skills")
      : undefined,
    bundle.mcpServers.length + bundle.localMcpServers.length > 0
      ? plural(
          bundle.mcpServers.length + bundle.localMcpServers.length,
          "MCP server",
          "MCP servers",
        )
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" and ");

export function PluginBundleDetails({
  bundle,
  canMutate,
  busy,
  run,
  previewUpdate,
  workspace,
  settingsReturnTo,
  initialUpdate,
  onDone,
}: Pick<SettingsSectionProps, "workspace" | "settingsReturnTo"> & {
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
  const [confirming, setConfirming] = React.useState(false);
  const [removeFailed, setRemoveFailed] = React.useState(false);
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
  const removes = removalSummary(bundle);
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
        skipped={bundle.skipped}
      />
      {(bundle.code?.settings.length ?? 0) === 0 ||
      (bundle.scope === "workspace" && workspace === undefined) ? null : (
        <PluginBundleSettingsForm
          target={
            bundle.scope === "workspace" && workspace !== undefined
              ? {
                  scope: "workspace",
                  workspaceSlug: workspace.shortName as never,
                }
              : { scope: "personal" }
          }
          pluginId={bundle.id}
          canMutate={canMutate}
        />
      )}
      {canMutate && (bundle.scope === "personal" || workspace !== undefined) ? (
        <PluginBundleShare
          bundle={bundle}
          target={
            bundle.scope === "workspace" && workspace !== undefined
              ? {
                  scope: "workspace",
                  workspaceSlug: workspace.shortName as never,
                }
              : { scope: "personal" }
          }
        />
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
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setRemoveFailed(false);
          setConfirming(open);
        }}
        title={`Remove ${bundle.displayName}?`}
        {...(removeFailed
          ? { error: `${bundle.displayName} wasn't removed. Try again.` }
          : {})}
        description={
          removes === ""
            ? "New Threads stop loading it."
            : `This also removes its ${removes}. New Threads stop loading them.`
        }
        confirmLabel={busy ? "Removing…" : "Remove"}
        destructive
        pending={busy}
        onConfirm={async () => {
          setRemoveFailed(false);
          const removed = await run(
            { type: "remove", pluginId: bundle.id },
            `${bundle.displayName} removed.`,
          );
          // A failure stays in the dialog, where the person is looking.
          if (!removed) return setRemoveFailed(true);
          setConfirming(false);
          onDone();
        }}
      />
      <footer className="plugin-bundle-actions">
        {canMutate ? (
          <Button
            size="xs"
            variant="danger"
            className="plugin-bundle-remove"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
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
