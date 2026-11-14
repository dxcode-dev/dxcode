import { Schema } from "effect";

/**
 * Plugin icons as clients receive them. Files are served
 * by the sha256 of their bytes at `GET /v1/plugins/icons/:sha256`, cached
 * for a year; clients draw them with dx's `PluginIcon`.
 */

export const PluginIconHashSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
);

/** An item's icon: `lucide:<name>` or an icon file's hash. */
export const PluginIconRefSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^(?:lucide:[a-z0-9]+(?:-[a-z0-9]+)*|[0-9a-f]{64})$/),
);

export type PluginIconRef = typeof PluginIconRefSchema.Type;

/**
 * A plugin's icon: `src` on light, `dark` on dark, else `monochrome` in the
 * text color, else `src` on a `background` tile.
 */
export const PluginIconSetSchema = Schema.Struct({
  src: Schema.optional(PluginIconHashSchema),
  dark: Schema.optional(PluginIconHashSchema),
  monochrome: Schema.optional(PluginIconHashSchema),
  background: Schema.optional(
    Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  ),
});

export type PluginIconSetData = typeof PluginIconSetSchema.Type;

/** Where an icon file is served. */
export const pluginIconPath = (hash: string) => `/v1/plugins/icons/${hash}`;
