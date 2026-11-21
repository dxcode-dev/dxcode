import type { PluginBundleData } from "@dx/api";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { type BundleRun, plural } from "./plugin-bundle-presentation.js";

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

/** The details' Remove button and the confirmation it opens. */
export function PluginBundleRemove({
  bundle,
  busy,
  run,
  onDone,
}: {
  readonly bundle: PluginBundleData;
  readonly busy: boolean;
  readonly run: BundleRun;
  readonly onDone: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [removeFailed, setRemoveFailed] = React.useState(false);
  const removes = removalSummary(bundle);
  return (
    <>
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
      <Button
        size="xs"
        variant="danger"
        className="plugin-bundle-remove"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
    </>
  );
}
