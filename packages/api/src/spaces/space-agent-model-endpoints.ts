import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";
import {
  GetSpaceAgentModelResponseSchema,
  UpdateSpaceAgentModelRequestSchema,
} from "./space-agent-model.js";

/**
 * The endpoints over `space-agent-model.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

export const SpaceAgentModelInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const SpaceAgentModelPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  );

/** The deployment has Spaces off. */
export const SpaceAgentModelSpacesUnavailableResponseSchema = errorResponse(
  "SPACES_UNAVAILABLE",
  "Spaces are off on this deployment.",
);

const spaceAgentModelRefusals = [
  { status: 400, schema: SpaceAgentModelInvalidRequestResponseSchema },
  { status: 503, schema: SpaceAgentModelPersistenceUnavailableResponseSchema },
  { status: 404, schema: SpaceAgentModelSpacesUnavailableResponseSchema },
];

export const GetSpaceAgentModelEndpoint = defineEndpoint({
  id: "spaceAgentModel.get",
  method: "GET",
  path: "/v1/settings/personal/space-agent-model",
  success: GetSpaceAgentModelResponseSchema,
  refusals: spaceAgentModelRefusals,
});

export const UpdateSpaceAgentModelEndpoint = defineEndpoint({
  id: "spaceAgentModel.update",
  method: "PUT",
  path: "/v1/settings/personal/space-agent-model",
  body: UpdateSpaceAgentModelRequestSchema,
  success: GetSpaceAgentModelResponseSchema,
  refusals: spaceAgentModelRefusals,
});
