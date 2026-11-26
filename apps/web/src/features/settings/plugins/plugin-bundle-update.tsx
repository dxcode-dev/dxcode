import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import { CircleAlert, KeyRound, Library, PlugZap } from "lucide-react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { Button } from "../../../shared/ui/button.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import { changeItems, permissionItems } from "./plugin-bundle-changes.js";
import { PluginBundleGroup } from "./plugin-bundle-group.js";
import { type BundleRun, plural } from "./plugin-bundle-presentation.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";
import { PluginPayerNote } from "./plugin-payer-note.js";

/** The reviewed update of an installed plugin: what changes, then Update. */
export function PluginBundleUpdate({
  bundle,
  target,
  update,
  file,
  busy,
  run,
  title,
  confirmLabel = "Update",
  onApply,
  onBack,
  onDone,
}: {
  /** The dialog's title; "Update <name>" by default. */
  readonly title?: string;
  /** The button that applies a change asking for nothing new. */
  readonly confirmLabel?: string;
  /**
   * Applies the reviewed change, such as edited files saved as a version;
   * an update from the plugin's source by default. Resolves true once done.
   */
  readonly onApply?: (acceptPermissions: boolean) => Promise<boolean>;
  readonly bundle: PluginBundleData;
  /** Where it is installed, for the payer line of a program. */
  readonly target?: PluginsTarget;
  readonly update: PluginBundleUpdatePreviewData;
  readonly file?: File;
  readonly busy: boolean;
  readonly run: BundleRun;
  readonly onBack: () => void;
  readonly onDone: () => void;
}) {
  const changed = [...update.skills, ...update.mcpServers].filter(
    ({ change }) => change !== "unchanged",
  ).length;
  const cleared = update.mcpServers.flatMap(({ name, credentialsCleared }) =>
    credentialsCleared ? [name] : [],
  );
  const serversToReview = update.mcpServers.some(
    ({ change, command }) =>
      command === undefined && (change === "added" || change === "changed"),
  );
  return (
    <div className="plugin-bundle-form">
      <header>
        <DialogTitle>{title ?? `Update ${bundle.displayName}`}</DialogTitle>
        <PluginBundleSourceLine
          source={update.source}
          version={update.manifest.version}
          signature={update.signature}
        />
        <DialogDescription>
          {update.upToDate
            ? "This plugin already matches its source."
            : changed === 0
              ? update.manifest.code === undefined
                ? "Only details that dx does not import changed."
                : update.permissions.changes.length === 0
                  ? "Its code changed. It does nothing new."
                  : "Its code and what it can do changed."
              : `${plural(changed, "item changes", "items change")}. Unchanged items keep their settings.`}
        </DialogDescription>
      </header>
      {update.upToDate ? null : (
        <div className="plugin-bundle-items">
          <PluginBundleGroup
            icon={<KeyRound aria-hidden="true" />}
            title="What changes"
            items={permissionItems(update.permissions.changes)}
          />
          <PluginBundleGroup
            icon={<Library aria-hidden="true" />}
            title="Skills"
            items={changeItems(update.skills)}
          />
          <PluginBundleGroup
            icon={<PlugZap aria-hidden="true" />}
            title="MCP servers"
            items={changeItems(update.mcpServers)}
          />
          {update.manifest.skipped.length === 0 ? null : (
            <details className="plugin-bundle-group plugin-bundle-skipped">
              <summary>
                <CircleAlert aria-hidden="true" />
                <span>Not imported</span>
                <span className="plugin-bundle-count">
                  {plural(update.manifest.skipped.length, "item", "items")}
                </span>
              </summary>
              <ul>
                {update.manifest.skipped.map(({ path, reason }) => (
                  <li key={`${path}:${reason}`}>
                    <code>{path}</code>
                    <span title={reason}>{reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {!update.upToDate && update.permissions.widens ? (
        <p className="plugin-bundle-help plugin-bundle-warning" role="note">
          This version does more than the one you allowed: see What changes.
          {bundle.scope === "workspace"
            ? " Saving allows it for every member of the workspace."
            : ""}
        </p>
      ) : null}
      {!update.upToDate && cleared.length > 0 ? (
        <p className="plugin-bundle-help plugin-bundle-warning" role="note">
          Credentials cleared because the server address changed:{" "}
          {cleared.join(", ")}. Saved tokens, secret headers, and sign-ins for
          the old address are deleted; enter them again in Integrations &amp;
          MCP.
        </p>
      ) : null}
      {update.upToDate ||
      target === undefined ||
      update.manifest.code?.service === undefined ? null : (
        <PluginPayerNote target={target} />
      )}
      {!update.upToDate && serversToReview ? (
        <p className="plugin-bundle-help">
          Added and changed MCP servers run no tools until you approve their
          tools again in Integrations &amp; MCP.
        </p>
      ) : null}
      {update.conflicts.length === 0 ? null : (
        <div className="plugin-bundle-conflicts" role="alert">
          <strong>dx can't apply this change</strong>
          <ul>
            {update.conflicts.map((conflict) => (
              <li key={conflict}>{conflict}</li>
            ))}
          </ul>
        </div>
      )}
      <footer className="plugin-bundle-actions">
        <Button
          size="xs"
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={onBack}
        >
          Back
        </Button>
        {update.upToDate ? null : (
          <Button
            size="xs"
            disabled={busy || update.conflicts.length > 0}
            onClick={async () => {
              // Pressing the button accepts what the review lists as new.
              const accept = update.permissions.widens;
              const updated =
                onApply === undefined
                  ? await run(
                      {
                        type: "update",
                        pluginId: bundle.id,
                        preview: update,
                        ...(file === undefined ? {} : { file }),
                        acceptPermissions: accept,
                      },
                      `${bundle.displayName} updated.`,
                    )
                  : await onApply(accept);
              if (updated) onDone();
            }}
          >
            {busy
              ? "Saving…"
              : update.permissions.widens
                ? `Allow and ${confirmLabel.toLowerCase()}`
                : confirmLabel}
          </Button>
        )}
      </footer>
    </div>
  );
}
