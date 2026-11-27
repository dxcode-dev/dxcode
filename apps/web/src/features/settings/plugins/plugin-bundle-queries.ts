import {
  GetPersonalPluginBundleSettingsEndpoint,
  GetPersonalPluginHostUsageEndpoint,
  GetWorkspacePluginBundleSettingsEndpoint,
  GetWorkspacePluginHostUsageEndpoint,
  InstallPersonalPluginBundleEndpoint,
  InstallPersonalPluginBundleZipEndpoint,
  InstallWorkspacePluginBundleEndpoint,
  InstallWorkspacePluginBundleZipEndpoint,
  ListPersonalPluginBundlesEndpoint,
  ListPersonalPluginBundleUpdatesEndpoint,
  ListWorkspacePluginBundlesEndpoint,
  ListWorkspacePluginBundleUpdatesEndpoint,
  type PluginBundleData,
  type PluginBundleListData,
  type PluginBundlePreviewData,
  type PluginBundleUpdatePreviewData,
  PreviewPersonalPluginBundleEndpoint,
  PreviewPersonalPluginBundleUpdateEndpoint,
  PreviewPersonalPluginBundleUpdateZipEndpoint,
  PreviewPersonalPluginBundleZipEndpoint,
  PreviewWorkspacePluginBundleEndpoint,
  PreviewWorkspacePluginBundleUpdateEndpoint,
  PreviewWorkspacePluginBundleUpdateZipEndpoint,
  PreviewWorkspacePluginBundleZipEndpoint,
  RemovePersonalPluginBundleEndpoint,
  RemoveWorkspacePluginBundleEndpoint,
  SetPersonalPluginBundleEnabledEndpoint,
  SetPersonalPluginBundleSettingsEndpoint,
  SetWorkspacePluginBundleEnabledEndpoint,
  SetWorkspacePluginBundleSettingsEndpoint,
  UpdatePersonalPluginBundleEndpoint,
  UpdatePersonalPluginBundleZipEndpoint,
  UpdateWorkspacePluginBundleEndpoint,
  UpdateWorkspacePluginBundleZipEndpoint,
} from "@dx/api";
import type { PluginCatalogId, PluginId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  ApiError,
  dxClient,
  type PluginsTarget,
} from "../../../shared/api/client.js";

export type { PluginBundleData, PluginBundleListData };

// The plugin bundle API lives with the Plugins settings, not in the shared
// client, so the Thread page's first load doesn't carry its schemas.

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

const workspace = (target: Extract<PluginsTarget, { scope: "workspace" }>) => ({
  workspaceSlug: target.workspaceSlug,
});

export const listPluginBundles = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(ListPersonalPluginBundlesEndpoint, {}, { signal })
    : await dxClient.call(
        ListWorkspacePluginBundlesEndpoint,
        { params: workspace(target) },
        { signal },
      )
  ).data;

/** A ZIP goes as its bytes, typed so Core reads it as an archive. */
const zipBody = (file: File) => new Blob([file], { type: "application/zip" });

export const previewPluginBundle = async (
  target: PluginsTarget,
  upload: Exclude<PluginBundleUpload, { type: "catalog" }>,
) => {
  if (upload.type === "zip") {
    const input = {
      query: { name: upload.file.name },
      body: zipBody(upload.file),
    };
    return (
      target.scope === "personal"
        ? await dxClient.call(PreviewPersonalPluginBundleZipEndpoint, input)
        : await dxClient.call(PreviewWorkspacePluginBundleZipEndpoint, {
            ...input,
            params: workspace(target),
          })
    ).data;
  }
  const body =
    upload.type === "share" ? { share: upload.token } : { url: upload.url };
  return (
    target.scope === "personal"
      ? await dxClient.call(PreviewPersonalPluginBundleEndpoint, { body })
      : await dxClient.call(PreviewWorkspacePluginBundleEndpoint, {
          params: workspace(target),
          body,
        })
  ).data;
};

/** Installs what the person reviewed: the same ZIP, or the pinned commit. */
export const installPluginBundle = async (
  target: PluginsTarget,
  upload: PluginBundleUpload,
  preview: PluginBundlePreviewData,
) => {
  if (upload.type === "zip") {
    const input = {
      query: { name: upload.file.name, integrity: preview.integrity },
      body: zipBody(upload.file),
    };
    return (
      target.scope === "personal"
        ? await dxClient.call(InstallPersonalPluginBundleZipEndpoint, input)
        : await dxClient.call(InstallWorkspacePluginBundleZipEndpoint, {
            ...input,
            params: workspace(target),
          })
    ).data;
  }
  const body =
    upload.type === "share"
      ? { share: upload.token, reviewedIntegrity: preview.integrity }
      : { source: preview.source, reviewedIntegrity: preview.integrity };
  return (
    target.scope === "personal"
      ? await dxClient.call(InstallPersonalPluginBundleEndpoint, { body })
      : await dxClient.call(InstallWorkspacePluginBundleEndpoint, {
          params: workspace(target),
          body,
        })
  ).data;
};

/** The install-time settings a plugin's code declares, with saved values. */
export const getPluginBundleSettings = async (
  target: PluginsTarget,
  pluginId: PluginId,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(
        GetPersonalPluginBundleSettingsEndpoint,
        { params: { pluginId } },
        { signal },
      )
    : await dxClient.call(
        GetWorkspacePluginBundleSettingsEndpoint,
        { params: { ...workspace(target), pluginId } },
        { signal },
      )
  ).data.settings;

/** Saves settings by key; null puts one back to its default. */
export const setPluginBundleSettings = async (
  target: PluginsTarget,
  pluginId: PluginId,
  values: Readonly<Record<string, string | number | boolean | null>>,
) =>
  (target.scope === "personal"
    ? await dxClient.call(SetPersonalPluginBundleSettingsEndpoint, {
        params: { pluginId },
        body: { values },
      })
    : await dxClient.call(SetWorkspacePluginBundleSettingsEndpoint, {
        params: { ...workspace(target), pluginId },
        body: { values },
      })
  ).data.settings;

/**
 * Reads an installed plugin's source again: the latest commit of its GitHub
 * ref, or `file` for a plugin imported from a ZIP.
 */
export const previewPluginBundleUpdate = async (
  target: PluginsTarget,
  pluginId: PluginId,
  file?: File,
) => {
  const params = { pluginId };
  if (file !== undefined) {
    const input = { query: { name: file.name }, body: zipBody(file) };
    return (
      target.scope === "personal"
        ? await dxClient.call(PreviewPersonalPluginBundleUpdateZipEndpoint, {
            ...input,
            params,
          })
        : await dxClient.call(PreviewWorkspacePluginBundleUpdateZipEndpoint, {
            ...input,
            params: { ...workspace(target), ...params },
          })
    ).data;
  }
  return (
    target.scope === "personal"
      ? await dxClient.call(PreviewPersonalPluginBundleUpdateEndpoint, {
          params,
          body: {},
        })
      : await dxClient.call(PreviewWorkspacePluginBundleUpdateEndpoint, {
          params: { ...workspace(target), ...params },
          body: {},
        })
  ).data;
};

/** Installs the reviewed update: the same ZIP, or the previewed commit. */
export const updatePluginBundle = async (
  target: PluginsTarget,
  pluginId: PluginId,
  preview: PluginBundleUpdatePreviewData,
  file?: File,
  /** The person reviewed and accepted the wider grants the preview lists. */
  acceptPermissions = false,
) => {
  const params = { pluginId };
  if (file !== undefined) {
    const input = {
      query: {
        name: file.name,
        integrity: preview.integrity,
        ...(acceptPermissions ? { acceptPermissions: "1" as const } : {}),
      },
      body: zipBody(file),
    };
    return (
      target.scope === "personal"
        ? await dxClient.call(UpdatePersonalPluginBundleZipEndpoint, {
            ...input,
            params,
          })
        : await dxClient.call(UpdateWorkspacePluginBundleZipEndpoint, {
            ...input,
            params: { ...workspace(target), ...params },
          })
    ).data;
  }
  const body = {
    source: preview.source,
    reviewedIntegrity: preview.integrity,
    ...(acceptPermissions ? { acceptPermissions: true } : {}),
  };
  return (
    target.scope === "personal"
      ? await dxClient.call(UpdatePersonalPluginBundleEndpoint, {
          params,
          body,
        })
      : await dxClient.call(UpdateWorkspacePluginBundleEndpoint, {
          params: { ...workspace(target), ...params },
          body,
        })
  ).data;
};

export const setPluginBundleEnabled = async (
  target: PluginsTarget,
  pluginId: PluginId,
  enabled: boolean,
) =>
  (target.scope === "personal"
    ? await dxClient.call(SetPersonalPluginBundleEnabledEndpoint, {
        params: { pluginId },
        body: { enabled },
      })
    : await dxClient.call(SetWorkspacePluginBundleEnabledEndpoint, {
        params: { ...workspace(target), pluginId },
        body: { enabled },
      })
  ).data;

export const removePluginBundle = async (
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  (target.scope === "personal"
    ? await dxClient.call(RemovePersonalPluginBundleEndpoint, {
        params: { pluginId },
      })
    : await dxClient.call(RemoveWorkspacePluginBundleEndpoint, {
        params: { ...workspace(target), pluginId },
      })
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
  (target.scope === "personal"
    ? await dxClient.call(
        ListPersonalPluginBundleUpdatesEndpoint,
        {},
        { signal },
      )
    : await dxClient.call(
        ListWorkspacePluginBundleUpdatesEndpoint,
        { params: workspace(target) },
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
      (target.scope === "personal"
        ? await dxClient.call(
            GetPersonalPluginHostUsageEndpoint,
            { params: { pluginId } },
            { signal },
          )
        : await dxClient.call(
            GetWorkspacePluginHostUsageEndpoint,
            { params: { ...workspace(target), pluginId } },
            { signal },
          )
      ).data,
    staleTime: 60_000,
  });
