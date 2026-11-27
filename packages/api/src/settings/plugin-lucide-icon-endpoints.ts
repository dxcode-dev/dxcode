import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";

/**
 * dx's Lucide icon endpoint, apart from `plugin-icons-endpoints.ts`, which
 * the first load imports; PluginIcon inlines this path instead.
 */

/** A Lucide icon's name, such as `git-branch`. */
export const LucideIconNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

export const LucideIconNotFoundResponseSchema = errorResponse(
  "NOT_FOUND",
  "dx has no Lucide icon with that name.",
);

/**
 * dx's own Lucide icon as SVG, for an item's `lucide:<name>` icon; a UI
 * points `<img src>` at `endpointPath`.
 */
export const GetLucideIconEndpoint = defineEndpoint({
  id: "plugins.icons.lucide",
  summary: "Read a Lucide icon",
  method: "GET",
  path: "/v1/plugins/icons/lucide/:name",
  params: Schema.Struct({ name: LucideIconNameSchema }),
  success: FileAnswerSchema,
  answer: "file",
  refusals: [{ status: 404, schema: LucideIconNotFoundResponseSchema }],
});
