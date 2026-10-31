import type { PluginBundleData } from "@dx/api";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { BundleItems } from "./plugin-bundle-items.js";
import { McpSettingsLink } from "./plugin-bundle-mcp-link.js";
import { type BundleRun, plural } from "./plugin-bundle-presentation.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";

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
  workspace,
  settingsReturnTo,
  onDone,
}: Pick<SettingsSectionProps, "workspace" | "settingsReturnTo"> & {
  readonly bundle: PluginBundleData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  readonly onDone: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const removes = removalSummary(bundle);
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
