import type { PluginBundleData } from "@dx/api";
import type { PluginId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { pluginBundleShareMutationOptions } from "./plugin-bundle-mutations.js";
import { errorMessage } from "./plugin-bundle-presentation.js";

/**
 * Share links for one install (plugin plan M5). A new link is shown once,
 * since dx keeps only its hash. Anyone signed in who opens it reviews the
 * plugin and installs a copy that follows this install's updates; Stop
 * sharing ends every link, and copies stop updating.
 */
export function PluginBundleShare({
  bundle,
  target,
}: {
  readonly bundle: PluginBundleData;
  readonly target: PluginsTarget;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const share = useMutation(
    pluginBundleShareMutationOptions(
      queryClient,
      identity.id,
      target,
      bundle.id as PluginId,
    ),
  );
  const [copied, setCopied] = React.useState<boolean>();
  const [confirmingStop, setConfirmingStop] = React.useState(false);
  const url = share.variables === "share" ? share.data : undefined;
  const stopped = share.variables === "stop" && share.isSuccess;
  const createLink = () =>
    share.mutate("share", {
      onSuccess: (created) => {
        setCopied(undefined);
        if (created === undefined) return;
        void navigator.clipboard?.writeText(created).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      },
    });
  const message = share.isError
    ? undefined
    : stopped
      ? "Sharing stopped. Copies people installed stop getting updates."
      : url === undefined
        ? undefined
        : copied === true
          ? "Link copied. Anyone signed in to dx can open it."
          : "Anyone signed in to dx can open this link.";
  return (
    <div className="plugin-bundle-share">
      {url === undefined ? null : (
        <Input
          readOnly
          aria-label={`Share link for ${bundle.displayName}`}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      {share.isError && !confirmingStop ? (
        <p className="plugin-bundle-error" role="alert">
          {errorMessage(share.error)}
        </p>
      ) : message === undefined ? null : (
        <p className="plugin-bundle-help" role="status">
          {message}
        </p>
      )}
      <div className="plugin-bundle-share-actions">
        <Button
          size="xs"
          variant="outline"
          disabled={share.isPending}
          onClick={createLink}
        >
          {share.isPending && share.variables === "share"
            ? "Creating…"
            : url === undefined
              ? "Share link"
              : "New link"}
        </Button>
        {(bundle.shared === true && !stopped) || url !== undefined ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={share.isPending}
            onClick={() => {
              if (share.isError) share.reset();
              setConfirmingStop(true);
            }}
          >
            Stop sharing
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmingStop}
        onOpenChange={setConfirmingStop}
        title={`Stop sharing ${bundle.displayName}?`}
        description="Every share link stops working, and copies people installed from them stop getting updates."
        confirmLabel={share.isPending ? "Stopping…" : "Stop sharing"}
        destructive
        pending={share.isPending}
        {...(share.isError ? { error: errorMessage(share.error) } : {})}
        onConfirm={() =>
          share.mutate("stop", { onSuccess: () => setConfirmingStop(false) })
        }
      />
    </div>
  );
}
