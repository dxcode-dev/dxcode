import type { PluginCatalogData, PluginCatalogListData } from "@dx/api";
import {
  AddPluginCatalogResponseSchema,
  ListPluginCatalogsResponseSchema,
  PreviewPluginBundleResponseSchema,
  RefreshPluginCatalogResponseSchema,
  RemovePluginCatalogResponseSchema,
} from "@dx/api";
import type { PluginCatalogId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { type PluginsTarget, request } from "../../../shared/api/client.js";

/** Plugin catalogs (`marketplace.json` files) a scope added from GitHub. */
const pluginCatalogsBase = (target: PluginsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/plugin-catalogs"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/plugin-catalogs`;

/** Reads one catalog entry through the plugin import; installs nothing. */
export const previewPluginCatalogEntry = async (
  target: PluginsTarget,
  catalogId: PluginCatalogId,
  name: string,
) =>
  (
    await request(
      `${pluginCatalogsBase(target)}/${encodeURIComponent(catalogId)}/entries/preview`,
      PreviewPluginBundleResponseSchema,
      { method: "POST", body: JSON.stringify({ name }) },
    )
  ).data;

export type { PluginCatalogData, PluginCatalogListData };

const listPluginCatalogs = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (
    await request(
      pluginCatalogsBase(target),
      ListPluginCatalogsResponseSchema,
      { signal },
    )
  ).data;

const addPluginCatalog = async (target: PluginsTarget, url: string) =>
  (
    await request(pluginCatalogsBase(target), AddPluginCatalogResponseSchema, {
      method: "POST",
      body: JSON.stringify({ url }),
    })
  ).data;

const refreshPluginCatalog = async (
  target: PluginsTarget,
  catalogId: PluginCatalogId,
) =>
  (
    await request(
      `${pluginCatalogsBase(target)}/${encodeURIComponent(catalogId)}/refresh`,
      RefreshPluginCatalogResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

const removePluginCatalog = async (
  target: PluginsTarget,
  catalogId: PluginCatalogId,
) =>
  (
    await request(
      `${pluginCatalogsBase(target)}/${encodeURIComponent(catalogId)}`,
      RemovePluginCatalogResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const pluginCatalogKeys = {
  all: (userId: UserId) => ["plugin-catalogs", userId] as const,
  list: (userId: UserId, target: PluginsTarget) =>
    [...pluginCatalogKeys.all(userId), target] as const,
};

export const pluginCatalogsQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: pluginCatalogKeys.list(userId, target),
    queryFn: ({ signal }) => listPluginCatalogs(target, signal),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });

export type PluginCatalogAction =
  | { readonly type: "add"; readonly url: string }
  | { readonly type: "refresh"; readonly catalogId: PluginCatalogId }
  | { readonly type: "remove"; readonly catalogId: PluginCatalogId };

const mutate = async (
  target: PluginsTarget,
  action: PluginCatalogAction,
): Promise<void> => {
  switch (action.type) {
    case "add":
      await addPluginCatalog(target, action.url);
      return;
    case "refresh":
      await refreshPluginCatalog(target, action.catalogId);
      return;
    case "remove":
      await removePluginCatalog(target, action.catalogId);
      return;
  }
};

/** Adding, refreshing, or removing a catalog installs nothing. */
export const pluginCatalogsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...pluginCatalogKeys.list(userId, target), "mutate"],
    gcTime: 0,
    mutationFn: (action: PluginCatalogAction) => mutate(target, action),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: pluginCatalogKeys.all(userId),
      }),
  });
