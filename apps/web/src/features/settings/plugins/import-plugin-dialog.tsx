import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { ImportPluginForm } from "./import-plugin-form.js";
import {
  type BundlePreview,
  type BundleRun,
  errorMessage,
} from "./plugin-bundle-presentation.js";
import {
  isBrokenShareLink,
  pluginSharePreviewQueryOptions,
} from "./plugin-bundle-queries.js";

/**
 * The share link someone opened (`?share=`), until its dialog closes. The
 * link goes to Personal Plugins; a workspace admin can open the same
 * `?share=` on Workspace Plugins to install it for the workspace.
 */
export function useSharedPluginLink() {
  const token = useRouterState({
    select: (state) =>
      new URLSearchParams(state.location.searchStr).get("share") ?? undefined,
  });
  const router = useRouter();
  const [dismissed, setDismissed] = React.useState<string>();
  return {
    token: token === dismissed ? undefined : token,
    // The token is a secret: once its dialog closes, it leaves the address
    // bar and history, so a reload doesn't open it again.
    dismiss: () => {
      if (token === undefined) return;
      setDismissed(token);
      const { pathname, search, hash } = window.location;
      const params = new URLSearchParams(search);
      params.delete("share");
      const rest = params.toString();
      router.history.replace(
        `${pathname}${rest === "" ? "" : `?${rest}`}${hash}`,
      );
    },
  };
}

/** Reads the shared plugin, then reviews it like any import. */
function SharedPluginReview({
  userId,
  target,
  installedNames,
  token,
  busy,
  preview,
  run,
  onClose,
}: {
  readonly userId: UserId;
  readonly target: PluginsTarget;
  readonly installedNames: ReadonlySet<string>;
  readonly token: string;
  readonly busy: boolean;
  readonly preview: BundlePreview;
  readonly run: BundleRun;
  readonly onClose: () => void;
}) {
  const shared = useQuery(pluginSharePreviewQueryOptions(target, token));
  if (shared.data !== undefined)
    return (
      <ImportPluginForm
        userId={userId}
        target={target}
        installedNames={installedNames}
        busy={busy}
        preview={preview}
        run={run}
        initialReview={{ upload: { type: "share", token }, data: shared.data }}
        onCancel={onClose}
      />
    );
  return (
    <div className="plugin-bundle-form">
      <header>
        <DialogTitle>Shared plugin</DialogTitle>
        <DialogDescription>
          {shared.isError
            ? isBrokenShareLink(shared.error)
              ? "This share link doesn't work. Its owner may have stopped sharing it."
              : errorMessage(shared.error)
            : "Reading the shared plugin…"}
        </DialogDescription>
      </header>
      <footer className="plugin-bundle-actions">
        <Button size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </footer>
    </div>
  );
}

export function ImportPluginDialog({
  userId,
  target,
  installedNames,
  open,
  share,
  busy,
  preview,
  run,
  onClose,
}: {
  readonly userId: UserId;
  readonly target: PluginsTarget;
  readonly installedNames: ReadonlySet<string>;
  readonly open: boolean;
  /** A share link's token: the dialog opens on that plugin's review. */
  readonly share?: string | undefined;
  readonly busy: boolean;
  readonly preview: BundlePreview;
  readonly run: BundleRun;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={open || share !== undefined}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {share !== undefined ? (
        <DialogContent className="plugin-bundle-dialog">
          <SharedPluginReview
            userId={userId}
            target={target}
            installedNames={installedNames}
            token={share}
            busy={busy}
            preview={preview}
            run={run}
            onClose={onClose}
          />
        </DialogContent>
      ) : open ? (
        <DialogContent className="plugin-bundle-dialog">
          <ImportPluginForm
            userId={userId}
            target={target}
            installedNames={installedNames}
            busy={busy}
            preview={preview}
            run={run}
            onCancel={onClose}
          />
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
