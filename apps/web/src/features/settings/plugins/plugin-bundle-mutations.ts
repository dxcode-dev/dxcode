import {
  CreatePluginShareLinkResponseSchema,
  DecidePluginProposalResponseSchema,
  ListPluginBundlesResponseSchema,
  type PluginBundlePreviewData,
  type PluginBundleUpdatePreviewData,
  type PluginProposalData,
  RevokePluginShareLinksResponseSchema,
  type SetPluginBundlePolicyRequest,
} from "@dx/api";
import type { PluginId, UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type PluginsTarget,
  request,
  requestBlob,
} from "../../../shared/api/client.js";
import { mcpServerKeys } from "../integrations/mcp-queries.js";
import { skillKeys } from "../skills/skills-queries.js";
import {
  installPluginBundle,
  type PluginBundleUpload,
  pluginBundleKeys,
  pluginBundleSettingsKey,
  pluginBundlesBase,
  pluginBundleUpdatesKey,
  previewPluginBundle,
  previewPluginBundleUpdate,
  removePluginBundle,
  setPluginBundleDev,
  setPluginBundleEnabled,
  setPluginBundleSettings,
  updatePluginBundle,
} from "./plugin-bundle-queries.js";
import { previewPluginCatalogEntry } from "./plugin-catalog-queries.js";

export type { PluginBundleUpload };

export type PluginBundleAction =
  | {
      readonly type: "install";
      readonly upload: PluginBundleUpload;
      readonly preview: PluginBundlePreviewData;
    }
  | {
      readonly type: "enabled";
      readonly pluginId: PluginId;
      readonly enabled: boolean;
    }
  | {
      readonly type: "update";
      readonly pluginId: PluginId;
      readonly preview: PluginBundleUpdatePreviewData;
      /** The new ZIP, for a plugin imported from one. */
      readonly file?: File;
      /** The person accepted the wider grants the preview listed. */
      readonly acceptPermissions?: boolean;
    }
  | { readonly type: "remove"; readonly pluginId: PluginId }
  | {
      readonly type: "dev";
      readonly pluginId: PluginId;
      readonly enabled: boolean;
      /** The Thread whose Orb may reload it; needed to turn it on. */
      readonly threadId?: string;
    }
  | ({ readonly type: "policy" } & SetPluginBundlePolicyRequest);

/** The workspace's plugin policies; an absent field stays as is. */
const setPluginBundlePolicy = (
  target: PluginsTarget,
  policy: SetPluginBundlePolicyRequest,
) =>
  request(
    `${pluginBundlesBase(target)}/policy`,
    ListPluginBundlesResponseSchema,
    { method: "PUT", body: JSON.stringify(policy) },
  );

const mutate = async (
  target: PluginsTarget,
  action: PluginBundleAction,
): Promise<void> => {
  switch (action.type) {
    case "install":
      await installPluginBundle(target, action.upload, action.preview);
      return;
    case "enabled":
      await setPluginBundleEnabled(target, action.pluginId, action.enabled);
      return;
    case "update":
      await updatePluginBundle(
        target,
        action.pluginId,
        action.preview,
        action.file,
        action.acceptPermissions === true,
      );
      return;
    case "dev":
      await setPluginBundleDev(
        target,
        action.pluginId,
        action.enabled,
        action.threadId,
      );
      return;
    case "remove":
      await removePluginBundle(target, action.pluginId);
      return;
    case "policy": {
      const { type: _type, ...policy } = action;
      await setPluginBundlePolicy(target, policy);
      return;
    }
  }
};

export const pluginBundlesMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...pluginBundleKeys.list(userId, target), "mutate"],
    gcTime: 0,
    mutationFn: (action: PluginBundleAction) => mutate(target, action),
    // A bundle installs and removes skills and MCP servers too.
    onSuccess: (_data, action) =>
      Promise.all([
        // A new version or install changes what is out of date.
        action.type === "update" ||
        action.type === "install" ||
        action.type === "remove"
          ? queryClient.invalidateQueries({
              queryKey: pluginBundleUpdatesKey(userId, target),
            })
          : undefined,
        queryClient.invalidateQueries({
          queryKey: pluginBundleKeys.all(userId),
        }),
        queryClient.invalidateQueries({ queryKey: skillKeys.all(userId) }),
        queryClient.invalidateQueries({ queryKey: mcpServerKeys.all(userId) }),
        // An update can add, drop, or retype the code's settings.
        queryClient.invalidateQueries({
          queryKey: pluginBundleSettingsKey.root,
        }),
      ]),
  });

/** Reads an installed bundle's source again; installs nothing. */
export const pluginBundleUpdatePreviewMutationOptions = (
  target: PluginsTarget,
) =>
  mutationOptions({
    gcTime: 0,
    mutationFn: ({
      pluginId,
      file,
    }: {
      readonly pluginId: PluginId;
      readonly file?: File;
    }) => previewPluginBundleUpdate(target, pluginId, file),
  });

/** Reads a bundle without installing anything; nothing is cached. */
export const pluginBundlePreviewMutationOptions = (target: PluginsTarget) =>
  mutationOptions({
    gcTime: 0,
    mutationFn: (upload: PluginBundleUpload) =>
      upload.type === "catalog"
        ? previewPluginCatalogEntry(target, upload.catalogId, upload.name)
        : previewPluginBundle(target, upload),
  });

/** Saves a plugin's settings and caches what the server read back. */
export const pluginBundleSettingsMutationOptions = (
  queryClient: QueryClient,
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  mutationOptions({
    mutationFn: (
      values: Readonly<Record<string, string | number | boolean | null>>,
    ) => setPluginBundleSettings(target, pluginId, values),
    onSuccess: (next) =>
      queryClient.setQueryData(pluginBundleSettingsKey(target, pluginId), next),
  });

/**
 * Creates a share link for one install (`share`) or ends all of them
 * (`stop`). A new link's URL is returned once; dx keeps only its hash.
 */
export const pluginBundleShareMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  mutationOptions({
    gcTime: 0,
    mutationFn: async (action: "share" | "stop") => {
      const path = `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/share`;
      if (action === "share")
        return (
          await request(path, CreatePluginShareLinkResponseSchema, {
            method: "POST",
            body: "{}",
          })
        ).data.url;
      await request(path, RevokePluginShareLinksResponseSchema, {
        method: "DELETE",
      });
      return undefined;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: pluginBundleKeys.all(userId),
      }),
  });

export type Decision = "approve" | "reject";

const decide = (
  target: PluginsTarget,
  proposal: PluginProposalData,
  decision: Decision,
) =>
  request(
    `${pluginBundlesBase(target)}/proposals/${encodeURIComponent(proposal.id)}/${decision}`,
    DecidePluginProposalResponseSchema,
    {
      method: "POST",
      body: JSON.stringify(
        decision === "approve" ? { reviewedIntegrity: proposal.integrity } : {},
      ),
    },
  );

/** Approves or rejects a plugin dx proposed; approval installs it. */
export const pluginProposalDecisionMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationFn: ({
      proposal,
      decision,
    }: {
      readonly proposal: PluginProposalData;
      readonly decision: Decision;
    }) => decide(target, proposal, decision),
    // Approval installs a plugin, with its skills and MCP servers.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: pluginBundleKeys.all(userId),
        }),
        queryClient.invalidateQueries({
          queryKey: pluginBundleUpdatesKey(userId, target),
        }),
        queryClient.invalidateQueries({ queryKey: skillKeys.all(userId) }),
        queryClient.invalidateQueries({ queryKey: mcpServerKeys.all(userId) }),
      ]),
  });

/**
 * The plugin's export with plugin.sig, signed with the person's managed dx
 * key, saved as `filename`. `exportPath` is the export route the plain
 * download uses. The download starts even if the dialog closed meanwhile.
 */
export const pluginBundleSignedExportMutationOptions = (
  exportPath: string,
  filename: string,
) =>
  mutationOptions({
    gcTime: 0,
    mutationFn: () =>
      requestBlob(`${exportPath}?sign=1`).catch((error: unknown) => {
        throw error instanceof ApiError && error.message !== "Request failed."
          ? error
          : new Error("dx could not sign the export.");
      }),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      // Revoked later: some browsers still read the URL after click().
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });
