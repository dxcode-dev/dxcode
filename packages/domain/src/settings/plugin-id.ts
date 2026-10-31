import { Schema } from "effect";

export const PluginId = Schema.String.check(
  Schema.isPattern(
    /^plg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/PluginId"));

export type PluginId = typeof PluginId.Type;
