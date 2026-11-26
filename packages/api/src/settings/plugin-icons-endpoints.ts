import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";
import { PluginIconHashSchema } from "./plugin-icons.js";

/** The plugin icon file endpoint, apart from `plugin-icons.ts`. */

export const PluginIconInvalidHashResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Not an icon hash.",
);
export const PluginIconNotFoundResponseSchema = errorResponse(
  "NOT_FOUND",
  "No plugin icon has that hash.",
);
export const PluginIconParamsSchema = Schema.Struct({
  sha256: PluginIconHashSchema,
});

/**
 * An icon file's bytes, for an `<img src>` at `endpointPath`; its answer is
 * the image, not JSON, so `call` does not read it.
 */
export const GetPluginIconEndpoint = defineEndpoint({
  id: "plugins.icons.get",
  summary: "Read a plugin icon",
  method: "GET",
  path: "/v1/plugins/icons/:sha256",
  params: PluginIconParamsSchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    { status: 400, schema: PluginIconInvalidHashResponseSchema },
    { status: 404, schema: PluginIconNotFoundResponseSchema },
  ],
});
