import {
  GetPluginAppUrlEndpoint,
  ListPluginAppsEndpoint,
  PluginViewsCatalogResponseSchema,
  PluginViewsErrorResponseSchema,
} from "@dx/api";
import { queryOptions } from "@tanstack/react-query";
import { dxClient, request } from "../../shared/api/client.js";

/**
 * The person's plugin views and Thread types (`GET /v1/plugins/views`).
 * Loaded only by a page, the new Thread type menu, or the command palette.
 */

const VIEWS_PATH = "/v1/plugins/views";

export const pluginViewsKeys = {
  all: ["plugin-views"] as const,
  catalog: () => [...pluginViewsKeys.all, "catalog"] as const,
};

export const pluginViewsCatalogQueryOptions = () =>
  queryOptions({
    queryKey: pluginViewsKeys.catalog(),
    queryFn: async ({ signal }) =>
      (
        await request(
          VIEWS_PATH,
          PluginViewsCatalogResponseSchema,
          { signal },
          PluginViewsErrorResponseSchema,
        )
      ).data,
    staleTime: 60_000,
    retry: 1,
  });

/**
 * A plugin's own web app: the person's plugins that have one, and where a
 * frame loads one now. Loaded only by the app page and the command palette.
 */

export const pluginAppKeys = {
  all: ["plugin-apps"] as const,
  list: () => [...pluginAppKeys.all, "list"] as const,
  url: (plugin: string) => [...pluginAppKeys.all, "url", plugin] as const,
};

export const pluginAppsQueryOptions = () =>
  queryOptions({
    queryKey: pluginAppKeys.list(),
    queryFn: async ({ signal }) =>
      (await dxClient.call(ListPluginAppsEndpoint, undefined, { signal })).data
        .apps,
    staleTime: 60_000,
    retry: 1,
  });

/**
 * The app's frame URL. Starting the program can wake its plugin Orb, so a
 * first answer can take seconds; the URL is offered for a few minutes and
 * the Portal session it opens lasts longer, so it is not read again while
 * the page stays open.
 */
export const pluginAppUrlQueryOptions = (plugin: string) =>
  queryOptions({
    queryKey: pluginAppKeys.url(plugin),
    queryFn: async ({ signal }) =>
      (
        await dxClient.call(
          GetPluginAppUrlEndpoint,
          { params: { plugin } },
          { signal },
        )
      ).data,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
