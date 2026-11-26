import { defineEndpoint } from "../http/endpoint.js";
import { PluginViewsCatalogResponseSchema } from "./plugin-views.js";

/**
 * The plugin views endpoint. Apart from `plugin-views.ts`, so code that
 * imports only the schemas does not carry it (wiki/headless-client.md).
 */

/**
 * The person's plugin views and Thread types. Always answers; an empty
 * catalog when the person installed no plugin with views.
 */
export const GetPluginViewsCatalogEndpoint = defineEndpoint({
  id: "pluginViews.catalog",
  method: "GET",
  path: "/v1/plugins/views",
  success: PluginViewsCatalogResponseSchema,
  refusals: [],
});
