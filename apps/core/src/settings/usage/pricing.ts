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
import {
  DX_PROVIDER_ID,
  findDxModel,
} from "../model-routing/deployment-models.js";

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

/** dx prices apply from the first record and stay fresh until changed. */
const DEPLOYMENT_PRICE_FROM = "2026-01-01T00:00:00.000Z";
const DEPLOYMENT_PRICE_FRESH_UNTIL = "2100-01-01T00:00:00.000Z";

/**
 * The operator's price for a dx model (deployment-models.ts): what the
 * person is charged, recorded with source `deployment`. The version names
 * the rates, so a price change is a new usage_price row.
 */
export const deploymentUsagePrice = (
  rawProviderId: string,
  rawModelId: string,
): UsagePriceMetadataType | undefined => {
  if (rawProviderId !== DX_PROVIDER_ID) return undefined;
  const model = findDxModel(rawModelId);
  if (model === undefined) return undefined;
  const rates = [
    model.price.input,
    model.price.output,
    model.price.cacheRead,
    model.price.cacheWrite,
  ].map(microsPerMillion);
  if (rates.some((rate) => rate === undefined)) return undefined;
  const [input, output, cacheRead, cacheWrite] = rates as Array<number>;
  return Option.getOrUndefined(
    Schema.decodeOption(UsagePriceMetadata)({
      providerId: DX_PROVIDER_ID,
      modelId: model.id,
      currency: "USD",
      source: "deployment",
      sourceVersion: `dx:${input}/${output}/${cacheRead}/${cacheWrite}`,
      inputMicrosPerMillion: input,
      outputMicrosPerMillion: output,
      cacheReadMicrosPerMillion: cacheRead,
      cacheWriteMicrosPerMillion: cacheWrite,
      effectiveFrom: DEPLOYMENT_PRICE_FROM,
      effectiveTo: null,
      freshUntil: DEPLOYMENT_PRICE_FRESH_UNTIL,
      estimated: true,
    }),
  );
};

/** The price a model request is recorded at: the operator's, else the catalog's. */
export const usagePrice = (
  providerId: string,
  modelId: string,
): UsagePriceMetadataType | undefined =>
  providerId === DX_PROVIDER_ID
    ? deploymentUsagePrice(providerId, modelId)
    : catalogUsagePrice(providerId, modelId);
