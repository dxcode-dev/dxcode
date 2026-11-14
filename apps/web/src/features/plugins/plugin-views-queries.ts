import {
  PluginPageViewResponseSchema,
  PluginViewsCatalogResponseSchema,
  PluginViewsErrorResponseSchema,
  PostPluginPaneMessageResponseSchema,
} from "@dx/api";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";

/**
 * The person's plugin pages and Thread types (`GET /v1/plugins/views`),
 * one page's view, and the messages a page's view sends its plugin. Loaded
 * only by a page, the new Thread type menu, or the command palette.
 */

const VIEWS_PATH = "/v1/plugins/views";

export const pluginViewsKeys = {
  all: ["plugin-views"] as const,
  catalog: () => [...pluginViewsKeys.all, "catalog"] as const,
  page: (plugin: string, page: string) =>
    [...pluginViewsKeys.all, "page", plugin, page] as const,
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

const pagePath = (plugin: string, page: string) =>
  `${VIEWS_PATH}/${encodeURIComponent(plugin)}/pages/${encodeURIComponent(page)}`;

export const pluginPageViewQueryOptions = (plugin: string, page: string) =>
  queryOptions({
    queryKey: pluginViewsKeys.page(plugin, page),
    queryFn: async ({ signal }) =>
      (
        await request(
          pagePath(plugin, page),
          PluginPageViewResponseSchema,
          { signal },
          PluginViewsErrorResponseSchema,
        )
      ).data,
    staleTime: 60_000,
    retry: 1,
  });

const errorDetail = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "data" in error &&
  typeof (error as { data?: { detail?: unknown } }).data?.detail === "string"
    ? (error as { data: { detail: string } }).data.detail
    : error instanceof Error
      ? error.message
      : "The plugin could not answer.";

/** A page view's `dx/plugin.post`: runs its `onMessage`; resolves its result. */
export const pluginPageMessageMutationOptions = (
  plugin: string,
  page: string,
) =>
  mutationOptions({
    mutationFn: async (message: unknown) => {
      try {
        return (
          await request(
            `${pagePath(plugin, page)}/messages`,
            PostPluginPaneMessageResponseSchema,
            { method: "POST", body: JSON.stringify({ message }) },
            PluginViewsErrorResponseSchema,
          )
        ).data.result;
      } catch (error) {
        throw new Error(errorDetail(error));
      }
    },
  });
