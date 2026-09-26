import {
  ModelProviderId,
  UsageModelId,
  UsagePriceMetadata,
  type UsagePriceMetadataType,
} from "@dx/domain";
import { Option, Schema } from "effect";
import {
  findCatalogModel,
  MODEL_CATALOG_SOURCE,
  modelCatalogGeneratedAt,
} from "../model-routing/catalog.js";

const PRICE_FRESHNESS_DAYS = 180;

const microsPerMillion = (price: number): number | undefined => {
  if (!Number.isFinite(price) || price < 0) return undefined;
  return Math.round(price * 1_000_000);
};

export const catalogUsagePrice = (
  rawProviderId: string,
  rawModelId: string,
): UsagePriceMetadataType | undefined => {
  const providerId = Schema.decodeOption(ModelProviderId)(rawProviderId);
  const modelId = Schema.decodeOption(UsageModelId)(rawModelId);
  if (
    Option.isNone(providerId) ||
    Option.isNone(modelId) ||
    modelCatalogGeneratedAt === undefined
  ) {
    return undefined;
  }
  const model = findCatalogModel(providerId.value, modelId.value);
  if (model === undefined) return undefined;
  const inputMicrosPerMillion = microsPerMillion(model.cost.input);
  const outputMicrosPerMillion = microsPerMillion(model.cost.output);
  const cacheReadMicrosPerMillion = microsPerMillion(model.cost.cacheRead);
  const cacheWriteMicrosPerMillion = microsPerMillion(model.cost.cacheWrite);
  if (
    inputMicrosPerMillion === undefined ||
    outputMicrosPerMillion === undefined ||
    cacheReadMicrosPerMillion === undefined ||
    cacheWriteMicrosPerMillion === undefined
  ) {
    return undefined;
  }
  const effectiveFrom = Schema.encodeSync(Schema.DateTimeUtcFromString)(
    modelCatalogGeneratedAt,
  );
  const freshUntil = new Date(
    new Date(effectiveFrom).getTime() + PRICE_FRESHNESS_DAYS * 86_400_000,
  ).toISOString();
  const decoded = Schema.decodeOption(UsagePriceMetadata)({
    providerId: providerId.value,
    modelId: modelId.value,
    currency: "USD",
    source: "catalog",
    sourceVersion: MODEL_CATALOG_SOURCE,
    inputMicrosPerMillion,
    outputMicrosPerMillion,
    cacheReadMicrosPerMillion,
    cacheWriteMicrosPerMillion,
    effectiveFrom,
    effectiveTo: null,
    freshUntil,
    estimated: true,
  });
  return Option.getOrUndefined(decoded);
};
