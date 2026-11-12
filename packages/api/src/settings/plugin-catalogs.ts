import {
  PluginCatalogEntry,
  PluginCatalogId,
  PluginCatalogPublisher,
  PluginCatalogSource,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/** A catalog (`marketplace.json`) added to a scope, with every entry. */
export const PluginCatalogDataSchema = Schema.Struct({
  id: PluginCatalogId,
  scope: Schema.Literals(["personal", "workspace"]),
  name: Schema.String,
  description: Schema.String,
  ownerName: Schema.optional(Schema.String),
  source: PluginCatalogSource,
  entries: Schema.Array(PluginCatalogEntry),
  /** Each publisher domain the entries claim, and how it was proven. */
  publishers: Schema.Array(PluginCatalogPublisher),
  addedAt: Timestamp,
  refreshedAt: Timestamp,
});

export type PluginCatalogData = typeof PluginCatalogDataSchema.Type;

export const ListPluginCatalogsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(PluginCatalogDataSchema),
    canMutate: Schema.Boolean,
  }),
);

export type PluginCatalogListData =
  typeof ListPluginCatalogsResponseSchema.Type.data;

export const AddPluginCatalogRequestSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2_048)),
});

export const AddPluginCatalogResponseSchema = successResponse(
  PluginCatalogDataSchema,
);

export const RefreshPluginCatalogResponseSchema = successResponse(
  PluginCatalogDataSchema,
);

export const RemovePluginCatalogResponseSchema = successResponse(
  Schema.Struct({ removedCatalogId: PluginCatalogId }),
);

export const PluginCatalogParamsSchema = Schema.Struct({
  catalogId: PluginCatalogId,
});

/** Previews one entry; the answer is a plugin bundle preview. */
export const PreviewPluginCatalogEntryRequestSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
