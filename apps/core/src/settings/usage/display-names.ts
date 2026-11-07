import {
  findCatalogModel,
  supportedProvider,
} from "../model-routing/catalog.js";
import { CUSTOM_PROVIDER_ID } from "../model-routing/service.js";

/** Names a usage row's provider the way Model Routing shows it. */
export const usageProviderName = (providerId: string): string => {
  if (providerId === CUSTOM_PROVIDER_ID) return "Custom URL";
  if (providerId === "cloudflare") return "Workers AI";
  return supportedProvider(providerId)?.name ?? providerId;
};

/** The model catalog's name, or the stored id when the catalog has none. */
export const usageModelName = (providerId: string, modelId: string): string =>
  findCatalogModel(providerId, modelId)?.name ?? modelId;
