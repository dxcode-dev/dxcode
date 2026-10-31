import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import * as React from "react";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { BundleItems } from "./plugin-bundle-items.js";
import { McpSettingsLink } from "./plugin-bundle-mcp-link.js";
import {
  type BundleRun,
  errorMessage,
  plural,
} from "./plugin-bundle-presentation.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";
import { PluginBundleUpdate } from "./plugin-bundle-update.js";

/** What removing a bundle also removes, for the confirmation. */
const removalSummary = (bundle: PluginBundleData) =>
  [
    bundle.skills.length > 0
      ? plural(bundle.skills.length, "skill", "skills")
      : undefined,
    bundle.mcpServers.length > 0
      ? plural(bundle.mcpServers.length, "MCP server", "MCP servers")
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
  onDone,
}: Pick<SettingsSectionProps, "workspace" | "settingsReturnTo"> & {
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
  const [update, setUpdate] = React.useState<{
    readonly data: PluginBundleUpdatePreviewData;
    readonly file?: File;
  }>();
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const removes = removalSummary(bundle);
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
        />
        {bundle.description === "" ? null : (
          <DialogDescription className="plugin-bundle-description">
            {bundle.description}
          </DialogDescription>
        )}
      </header>
      <BundleItems
        skills={bundle.skills}
        mcpServers={bundle.mcpServers}
        skipped={bundle.skipped}
      />
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
      {confirming ? (
        <footer className="plugin-bundle-actions plugin-bundle-confirm">
          <p>
            Remove {bundle.displayName}
            {removes === "" ? "" : ` and its ${removes}`}?
          </p>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              const removed = await run(
                { type: "remove", pluginId: bundle.id },
                `${bundle.displayName} removed.`,
              );
              if (removed) onDone();
            }}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </footer>
      ) : (
        <footer className="plugin-bundle-actions">
          {canMutate ? (
            <Button
              size="xs"
              variant="ghost"
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
                bundle.source.type === "github"
                  ? void check()
                  : fileInput.current?.click()
              }
            >
              {checking
                ? "Checking…"
                : bundle.source.type === "github"
                  ? "Check for updates"
                  : "Upload new ZIP"}
            </Button>
          ) : null}
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
      )}
    </div>
  );
}
