import type { PluginBundleData, PluginBundleUpdatePreviewData } from "@dx/api";
import type { PluginId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { errorMessage } from "./plugin-bundle-presentation.js";
import { previewPluginBundleUpdate } from "./plugin-bundle-queries.js";
import type { Panel } from "./plugin-details.js";
import {
  type EditedPluginFile,
  previewPluginFiles,
  savePluginFilesMutationOptions,
} from "./plugin-files-queries.js";

/** Thrown to keep an edit open while its review shows. */
class SentToReview extends Error {}

/**
 * How a plugin gets its next version on the Plugins page: an edited file,
 * a new ZIP, or a newer commit at its source. Edits save at once for a
 * personal plugin that asks for nothing new; anything else opens a review
 * (`openPanel`), and saving there accepts what it lists.
 */
export function usePluginVersions(
  target: PluginsTarget,
  report: (message: string | undefined) => void,
  openPanel: (panel: Panel) => void,
) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const saveFiles = useMutation(
    savePluginFilesMutationOptions(queryClient, identity.id, target),
  );
  const [checking, setChecking] = React.useState(false);
  /** Saves edited files: at once when nothing needs review. */
  const saveEdit = async (
    plugin: PluginBundleData,
    edited: ReadonlyArray<EditedPluginFile>,
  ) => {
    report(undefined);
    const previewed = await settle(() =>
      previewPluginFiles(target, plugin.id as PluginId, edited),
    );
    if (!previewed.ok) {
      report(`Could not save: ${errorMessage(previewed.error)}`);
      throw previewed.error;
    }
    const preview = previewed.value;
    if (preview.upToDate) {
      report("Nothing changed.");
      return;
    }
    if (
      plugin.scope === "personal" &&
      !preview.permissions.widens &&
      preview.conflicts.length === 0
    ) {
      const saved = await settle(() =>
        saveFiles.mutateAsync({
          pluginId: plugin.id as PluginId,
          files: edited,
          preview,
          acceptPermissions: false,
        }),
      );
      saveFiles.reset();
      if (!saved.ok) {
        report(`Could not save: ${errorMessage(saved.error)}`);
        throw saved.error;
      }
      report(
        `${plugin.displayName} saved${saved.value.version === undefined ? "" : ` as version ${saved.value.version}`}. New Threads use it.`,
      );
      return;
    }
    openPanel({ kind: "review", bundle: plugin, preview, files: edited });
    report(
      preview.permissions.widens
        ? `${plugin.displayName} would do more than before. Review it to save.`
        : "Review the change to save it.",
    );
    // The edit stays open behind the review.
    throw new SentToReview();
  };

  const checkUpdate = async (plugin: PluginBundleData, zip?: File) => {
    report(undefined);
    setChecking(true);
    const outcome = await settle(() =>
      previewPluginBundleUpdate(target, plugin.id as PluginId, zip),
    );
    setChecking(false);
    if (!outcome.ok) return report(errorMessage(outcome.error));
    if (outcome.value.upToDate)
      return report(`${plugin.displayName} already matches its source.`);
    openPanel({
      kind: "review",
      bundle: plugin,
      preview: outcome.value,
      ...(zip === undefined ? {} : { zip }),
    });
  };

  /** Saves reviewed edits as the plugin's next version; true once saved. */
  const saveReviewed = async (
    plugin: PluginBundleData,
    edited: ReadonlyArray<EditedPluginFile>,
    preview: PluginBundleUpdatePreviewData,
    acceptPermissions: boolean,
  ) => {
    const saved = await settle(() =>
      saveFiles.mutateAsync({
        pluginId: plugin.id as PluginId,
        files: edited,
        preview,
        acceptPermissions,
      }),
    );
    saveFiles.reset();
    report(
      saved.ok
        ? `${plugin.displayName} saved. New Threads use it.`
        : `Could not save: ${errorMessage(saved.error)}`,
    );
    return saved.ok;
  };

  return {
    saveEdit,
    saveReviewed,
    checkUpdate,
    checking,
    saving: saveFiles.isPending,
  };
}
