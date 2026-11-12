import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import { CircleAlert, KeyRound, Library, PlugZap } from "lucide-react";
import { Button } from "../../../shared/ui/button.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import { changeItems, permissionItems } from "./plugin-bundle-changes.js";
import { PluginBundleGroup } from "./plugin-bundle-group.js";
import { type BundleRun, plural } from "./plugin-bundle-presentation.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";

/** The reviewed update of an installed plugin: what changes, then Update. */
export function PluginBundleUpdate({
  bundle,
  update,
  file,
  busy,
  run,
  onBack,
  onDone,
}: {
  readonly bundle: PluginBundleData;
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
        <DialogTitle>Update {bundle.displayName}</DialogTitle>
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
                  ? "Its code changed; it asks for the same permissions."
                  : "Its code and permissions changed."
              : `${plural(changed, "item changes", "items change")}. Unchanged items keep their settings.`}
        </DialogDescription>
      </header>
      {update.upToDate ? null : (
        <div className="plugin-bundle-items">
          <PluginBundleGroup
            icon={<KeyRound aria-hidden="true" />}
            title="Permissions"
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
          This version asks for more than you approved.
          {bundle.scope === "workspace"
            ? " Updating grants it for every member of the workspace."
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
      {!update.upToDate && serversToReview ? (
        <p className="plugin-bundle-help">
          Added and changed MCP servers run no tools until you approve their
          tools again in Integrations &amp; MCP.
        </p>
      ) : null}
      {update.conflicts.length === 0 ? null : (
        <div className="plugin-bundle-conflicts" role="alert">
          <strong>This update can't be installed</strong>
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
              const updated = await run(
                {
                  type: "update",
                  pluginId: bundle.id,
                  preview: update,
                  ...(file === undefined ? {} : { file }),
                  // Pressing Update here accepts the grants listed above.
                  acceptPermissions: update.permissions.widens,
                },
                `${bundle.displayName} updated.`,
              );
              if (updated) onDone();
            }}
          >
            {busy
              ? "Updating…"
              : update.permissions.widens
                ? "Accept and update"
                : "Update"}
          </Button>
        )}
      </footer>
    </div>
  );
}
