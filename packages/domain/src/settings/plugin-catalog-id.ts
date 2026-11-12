import { Schema } from "effect";

export const PluginCatalogId = Schema.String.check(
  Schema.isPattern(
    /^pcat_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/PluginCatalogId"));

export type PluginCatalogId = typeof PluginCatalogId.Type;

/** A catalog's `name`, by the same rule as plugin names. */
export const PluginCatalogName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
).pipe(Schema.brand("@dx/PluginCatalogName"));

export type PluginCatalogName = typeof PluginCatalogName.Type;

/** The catalog an installed plugin came from, when its publisher was proven. */
export const PluginCatalogReference = Schema.Struct({
  id: PluginCatalogId,
  name: PluginCatalogName,
});

export type PluginCatalogReference = typeof PluginCatalogReference.Type;
