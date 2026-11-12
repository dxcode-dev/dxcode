import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import type { PluginId, UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { settle } from "../../../shared/settle.js";
import { type BundleRun, errorMessage } from "./plugin-bundle-presentation.js";
import { pluginBundleUpdatesQueryOptions } from "./plugin-bundle-queries.js";

/**
 * The row's "Update" for a plugin whose source has a newer version (plan
 * §7): a version asking for the same or fewer grants updates in one click;
 * one asking for more, or one that can't install, opens its review.
 */
export function usePluginBundleQuickUpdate({
  userId,
  target,
  bundles,
  canMutate,
  previewUpdate,
  run,
  report,
  review,
}: {
  readonly userId: UserId;
  readonly target: PluginsTarget;
  readonly bundles: ReadonlyArray<PluginBundleData>;
  readonly canMutate: boolean;
  readonly previewUpdate: (
    pluginId: PluginId,
  ) => Promise<PluginBundleUpdatePreviewData>;
  readonly run: BundleRun;
  readonly report: (message: string) => void;
  /** Opens the plugin's dialog on this update's review. */
  readonly review: (pluginId: PluginId) => void;
}) {
  const updates = useQuery({
    ...pluginBundleUpdatesQueryOptions(userId, target),
    enabled: canMutate && bundles.some(({ source }) => source.type !== "zip"),
  });
  const available = new Set(
    (updates.data?.items ?? []).flatMap(({ pluginId, available: newer }) =>
      newer ? [pluginId] : [],
    ),
  );
  const [reviewing, setReviewing] = React.useState<{
    readonly pluginId: PluginId;
    readonly data: PluginBundleUpdatePreviewData;
  }>();
  const [checking, setChecking] = React.useState<PluginId>();
  const update = async (bundle: PluginBundleData) => {
    setChecking(bundle.id);
    const outcome = await settle(() => previewUpdate(bundle.id));
    setChecking(undefined);
    if (!outcome.ok) {
      report(errorMessage(outcome.error));
      return;
    }
    const preview = outcome.value;
    if (preview.upToDate) {
      report(`${bundle.displayName} already matches its source.`);
      return;
    }
    if (!preview.permissions.widens && preview.conflicts.length === 0) {
      await run(
        { type: "update", pluginId: bundle.id, preview },
        `${bundle.displayName} updated.`,
      );
      return;
    }
    setReviewing({ pluginId: bundle.id, data: preview });
    review(bundle.id);
  };
  return {
    available,
    checking,
    /** The review the dialog opens on, for this plugin only. */
    reviewFor: (pluginId: PluginId) =>
      reviewing?.pluginId === pluginId ? reviewing.data : undefined,
    clearReview: () => setReviewing(undefined),
    update,
  };
}
