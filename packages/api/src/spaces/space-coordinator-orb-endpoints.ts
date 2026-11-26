import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  SpaceCoordinatorOrbForbiddenResponseSchema,
  SpaceCoordinatorOrbInvalidRequestResponseSchema,
  SpaceCoordinatorOrbNotFoundResponseSchema,
  SpaceCoordinatorOrbPersistenceUnavailableResponseSchema,
  SpaceCoordinatorOrbResponseSchema,
  SpaceCoordinatorOrbSpacesUnavailableResponseSchema,
  UpdateSpaceCoordinatorOrbRequestSchema,
} from "./space-coordinator-orb.js";

/**
 * The endpoints over `space-coordinator-orb.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

const spaceCoordinatorOrbRefusals = [
  { status: 400, schema: SpaceCoordinatorOrbInvalidRequestResponseSchema },
  { status: 404, schema: SpaceCoordinatorOrbNotFoundResponseSchema },
  { status: 403, schema: SpaceCoordinatorOrbForbiddenResponseSchema },
  {
    status: 503,
    schema: SpaceCoordinatorOrbPersistenceUnavailableResponseSchema,
  },
  { status: 404, schema: SpaceCoordinatorOrbSpacesUnavailableResponseSchema },
];

export const WorkspaceSpaceCoordinatorOrbParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const GetPersonalSpaceCoordinatorOrbEndpoint = defineEndpoint({
  id: "spaceCoordinatorOrb.personal.get",
  method: "GET",
  path: "/v1/settings/personal/space-coordinator-orb",
  success: SpaceCoordinatorOrbResponseSchema,
  refusals: spaceCoordinatorOrbRefusals,
});

export const GetWorkspaceSpaceCoordinatorOrbEndpoint = defineEndpoint({
  id: "spaceCoordinatorOrb.workspace.get",
  method: "GET",
  path: "/v1/settings/workspaces/:workspaceSlug/space-coordinator-orb",
  params: WorkspaceSpaceCoordinatorOrbParamsSchema,
  success: SpaceCoordinatorOrbResponseSchema,
  refusals: spaceCoordinatorOrbRefusals,
});

export const UpdatePersonalSpaceCoordinatorOrbEndpoint = defineEndpoint({
  id: "spaceCoordinatorOrb.personal.update",
  method: "PUT",
  path: "/v1/settings/personal/space-coordinator-orb",
  body: UpdateSpaceCoordinatorOrbRequestSchema,
  success: SpaceCoordinatorOrbResponseSchema,
  refusals: spaceCoordinatorOrbRefusals,
});

export const UpdateWorkspaceSpaceCoordinatorOrbEndpoint = defineEndpoint({
  id: "spaceCoordinatorOrb.workspace.update",
  method: "PUT",
  path: "/v1/settings/workspaces/:workspaceSlug/space-coordinator-orb",
  params: WorkspaceSpaceCoordinatorOrbParamsSchema,
  body: UpdateSpaceCoordinatorOrbRequestSchema,
  success: SpaceCoordinatorOrbResponseSchema,
  refusals: spaceCoordinatorOrbRefusals,
});
