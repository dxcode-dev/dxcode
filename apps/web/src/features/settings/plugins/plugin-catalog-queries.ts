import type { PluginCatalogData, PluginCatalogListData } from "@dx/api";
import {
  AddPersonalPluginCatalogEndpoint,
  AddWorkspacePluginCatalogEndpoint,
  ListPersonalPluginCatalogsEndpoint,
  ListWorkspacePluginCatalogsEndpoint,
  PreviewPersonalPluginCatalogEntryEndpoint,
  PreviewWorkspacePluginCatalogEntryEndpoint,
  RefreshPersonalPluginCatalogEndpoint,
  RefreshWorkspacePluginCatalogEndpoint,
  RemovePersonalPluginCatalogEndpoint,
  RemoveWorkspacePluginCatalogEndpoint,
} from "@dx/api";
import type { PluginCatalogId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import type { PluginsTarget } from "./plugins-queries.js";

/** Plugin catalogs (`marketplace.json` files) a scope added from GitHub. */
const workspace = (target: Extract<PluginsTarget, { scope: "workspace" }>) => ({
  workspaceSlug: target.workspaceSlug,
});

/** Reads one catalog entry through the plugin import; installs nothing. */
export const previewPluginCatalogEntry = async (
  target: PluginsTarget,
  catalogId: PluginCatalogId,
  name: string,
) =>
  (target.scope === "personal"
    ? await dxClient.call(PreviewPersonalPluginCatalogEntryEndpoint, {
        params: { catalogId },
        body: { name },
      })
    : await dxClient.call(PreviewWorkspacePluginCatalogEntryEndpoint, {
        params: { ...workspace(target), catalogId },
        body: { name },
      })
  ).data;

export type { PluginCatalogData, PluginCatalogListData };

const listPluginCatalogs = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(ListPersonalPluginCatalogsEndpoint, {}, { signal })
    : await dxClient.call(
        ListWorkspacePluginCatalogsEndpoint,
        { params: workspace(target) },
        { signal },
      )
  ).data;

const addPluginCatalog = async (target: PluginsTarget, url: string) =>
  (target.scope === "personal"
    ? await dxClient.call(AddPersonalPluginCatalogEndpoint, { body: { url } })
    : await dxClient.call(AddWorkspacePluginCatalogEndpoint, {
        params: workspace(target),
        body: { url },
      })
  ).data;

const refreshPluginCatalog = async (
  target: PluginsTarget,
  catalogId: PluginCatalogId,
) =>
  (target.scope === "personal"
    ? await dxClient.call(RefreshPersonalPluginCatalogEndpoint, {
        params: { catalogId },
        body: {},
      })
    : await dxClient.call(RefreshWorkspacePluginCatalogEndpoint, {
        params: { ...workspace(target), catalogId },
        body: {},
      })
  ).data;

const removePluginCatalog = async (
  target: PluginsTarget,
  catalogId: PluginCatalogId,
) =>
  (target.scope === "personal"
    ? await dxClient.call(RemovePersonalPluginCatalogEndpoint, {
        params: { catalogId },
      })
    : await dxClient.call(RemoveWorkspacePluginCatalogEndpoint, {
        params: { ...workspace(target), catalogId },
      })
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
