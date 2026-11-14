import {
  InstallPluginBundleResponseSchema,
  ListPluginBundlesResponseSchema,
  ListPluginBundleUpdatesResponseSchema,
  type PluginBundleData,
  type PluginBundleListData,
  type PluginBundlePreviewData,
  PluginBundleSettingsResponseSchema,
  type PluginBundleUpdatePreviewData,
  PluginHostUsageResponseSchema,
  PreviewPluginBundleResponseSchema,
  PreviewPluginBundleUpdateResponseSchema,
  RemovePluginBundleResponseSchema,
  UpdatePluginBundleResponseSchema,
  UpdatePluginBundleSourceResponseSchema,
} from "@dx/api";
import type { PluginCatalogId, PluginId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  ApiError,
  type PluginsTarget,
  request,
} from "../../../shared/api/client.js";

export type { PluginBundleData, PluginBundleListData };

// The plugin bundle API lives with the Plugins settings, not in the shared
// client, so the Thread page's first load doesn't carry its schemas.
/** Plugin bundles in the Agent Plugins or Claude Code format: skills and MCP servers. */
export const pluginBundlesBase = (target: PluginsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/plugin-bundles"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/plugin-bundles`;

export type PluginBundleUpload =
  | { readonly type: "zip"; readonly file: File }
  | { readonly type: "github"; readonly url: string }
  /** A share link's token. */
  | { readonly type: "share"; readonly token: string }
  | {
      /** One entry of a catalog the scope added. */
      readonly type: "catalog";
      readonly catalogId: PluginCatalogId;
      readonly name: string;
    };

export const listPluginBundles = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (
    await request(pluginBundlesBase(target), ListPluginBundlesResponseSchema, {
      signal,
    })
  ).data;

const zipInit = (file: File): RequestInit => ({
  method: "POST",
  body: file,
  headers: { "content-type": "application/zip" },
});

export const previewPluginBundle = async (
  target: PluginsTarget,
  upload: Exclude<PluginBundleUpload, { type: "catalog" }>,
) =>
  (
    await request(
      upload.type === "zip"
        ? `${pluginBundlesBase(target)}/preview?name=${encodeURIComponent(upload.file.name)}`
        : `${pluginBundlesBase(target)}/preview`,
      PreviewPluginBundleResponseSchema,
      upload.type === "zip"
        ? zipInit(upload.file)
        : {
            method: "POST",
            body: JSON.stringify(
              upload.type === "share"
                ? { share: upload.token }
                : { url: upload.url },
            ),
          },
    )
  ).data;

/** Installs what the person reviewed: the same ZIP, or the pinned commit. */
export const installPluginBundle = async (
  target: PluginsTarget,
  upload: PluginBundleUpload,
  preview: PluginBundlePreviewData,
) =>
  (
    await request(
      upload.type === "zip"
        ? `${pluginBundlesBase(target)}?name=${encodeURIComponent(upload.file.name)}&integrity=${preview.integrity}`
        : pluginBundlesBase(target),
      InstallPluginBundleResponseSchema,
      upload.type === "zip"
        ? zipInit(upload.file)
        : {
            method: "POST",
            body: JSON.stringify(
              upload.type === "share"
                ? { share: upload.token, reviewedIntegrity: preview.integrity }
                : {
                    source: preview.source,
                    reviewedIntegrity: preview.integrity,
                  },
            ),
          },
    )
  ).data;

/** The install-time settings a plugin's code declares, with saved values. */
export const getPluginBundleSettings = async (
  target: PluginsTarget,
  pluginId: PluginId,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/settings`,
      PluginBundleSettingsResponseSchema,
      { signal },
    )
  ).data.settings;

/** Saves settings by key; null puts one back to its default. */
export const setPluginBundleSettings = async (
  target: PluginsTarget,
  pluginId: PluginId,
  values: Readonly<Record<string, string | number | boolean | null>>,
) =>
  (
    await request(
      `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/settings`,
      PluginBundleSettingsResponseSchema,
      { method: "PUT", body: JSON.stringify({ values }) },
    )
  ).data.settings;

/**
 * Reads an installed plugin's source again: the latest commit of its GitHub
 * ref, or `file` for a plugin imported from a ZIP.
 */
export const previewPluginBundleUpdate = async (
  target: PluginsTarget,
  pluginId: PluginId,
  file?: File,
) =>
  (
    await request(
      file === undefined
        ? `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/update/preview`
        : `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/update/preview?name=${encodeURIComponent(file.name)}`,
      PreviewPluginBundleUpdateResponseSchema,
      file === undefined
        ? { method: "POST", body: JSON.stringify({}) }
        : zipInit(file),
    )
  ).data;

/** Installs the reviewed update: the same ZIP, or the previewed commit. */
export const updatePluginBundle = async (
  target: PluginsTarget,
  pluginId: PluginId,
  preview: PluginBundleUpdatePreviewData,
  file?: File,
  /** The person reviewed and accepted the wider grants the preview lists. */
  acceptPermissions = false,
) =>
  (
    await request(
      file === undefined
        ? `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/update`
        : `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/update?name=${encodeURIComponent(file.name)}&integrity=${preview.integrity}${acceptPermissions ? "&acceptPermissions=1" : ""}`,
      UpdatePluginBundleSourceResponseSchema,
      file === undefined
        ? {
            method: "POST",
            body: JSON.stringify({
              source: preview.source,
              reviewedIntegrity: preview.integrity,
              ...(acceptPermissions ? { acceptPermissions: true } : {}),
            }),
          }
        : zipInit(file),
    )
  ).data;

export const setPluginBundleEnabled = async (
  target: PluginsTarget,
  pluginId: PluginId,
  enabled: boolean,
) =>
  (
    await request(
      `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}`,
      UpdatePluginBundleResponseSchema,
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    )
  ).data;

/** Turns personal-dev hot reload on or off for a personal plugin. */
export const setPluginBundleDev = async (
  target: PluginsTarget,
  pluginId: PluginId,
  enabled: boolean,
  threadId?: string,
) =>
  (
    await request(
      `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/dev`,
      UpdatePluginBundleResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          ...(threadId === undefined ? {} : { threadId }),
        }),
      },
    )
  ).data;

export const removePluginBundle = async (
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  (
    await request(
      `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}`,
      RemovePluginBundleResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const pluginBundleKeys = {
  all: (userId: UserId) => ["plugin-bundles", userId] as const,
  list: (userId: UserId, target: PluginsTarget) =>
    [...pluginBundleKeys.all(userId), target] as const,
};

export const pluginBundlesQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: pluginBundleKeys.list(userId, target),
    queryFn: ({ signal }) => listPluginBundles(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

/** Which plugins changed at their source; unchecked ones are absent. */
const listPluginBundleUpdates = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${pluginBundlesBase(target)}/updates`,
      ListPluginBundleUpdatesResponseSchema,
      { signal },
    )
  ).data;

/** Kept apart from the list, so a toggle doesn't ask GitHub again. */
export const pluginBundleUpdatesKey = (userId: UserId, target: PluginsTarget) =>
  ["plugin-bundle-updates", userId, target] as const;

/**
 * Which installed plugins have a newer version at their source. Each check
 * asks GitHub once per plugin, so it runs rarely.
 */
export const pluginBundleUpdatesQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: pluginBundleUpdatesKey(userId, target),
    queryFn: ({ signal }) => listPluginBundleUpdates(target, signal),
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });

export const pluginBundleSettingsKey = Object.assign(
  (target: PluginsTarget, pluginId: PluginId) =>
    ["plugin-bundle-settings", target, pluginId] as const,
  { root: ["plugin-bundle-settings"] as const },
);

/** The settings a plugin's code declares, with this install's values. */
export const pluginBundleSettingsQueryOptions = (
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  queryOptions({
    queryKey: pluginBundleSettingsKey(target, pluginId),
    queryFn: ({ signal }) => getPluginBundleSettings(target, pluginId, signal),
    staleTime: 15_000,
  });

/** What a share link would install; read once, never cached after. */
export const pluginSharePreviewQueryOptions = (
  target: PluginsTarget,
  token: string,
) =>
  queryOptions({
    queryKey: ["plugin-share-preview", target, token] as const,
    queryFn: () => previewPluginBundle(target, { type: "share", token }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

/** A share link that no longer resolves: revoked, or never valid. */
export const isBrokenShareLink = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

// Host cost line
/** What the plugin's long-lived hosts cost this month, per host. */
export const pluginHostUsageQueryOptions = (
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  queryOptions({
    queryKey: ["plugin-host-usage", target, pluginId] as const,
    queryFn: async ({ signal }) =>
      (
        await request(
          `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/host-usage`,
          PluginHostUsageResponseSchema,
          { signal },
        )
      ).data,
    staleTime: 60_000,
  });
