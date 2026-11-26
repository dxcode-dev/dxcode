import { defineEndpoint } from "../http/endpoint.js";
import {
  GetProjectOrbScriptsResponseSchema,
  ProjectOrbScriptsForbiddenResponseSchema,
  ProjectOrbScriptsInvalidRequestResponseSchema,
  ProjectOrbScriptsNotFoundResponseSchema,
  ProjectOrbScriptsParamsSchema,
  ProjectOrbScriptsPersistenceUnavailableResponseSchema,
  UpdateProjectOrbScriptParamsSchema,
  UpdateProjectOrbScriptRequestSchema,
  UpdateProjectOrbScriptResponseSchema,
} from "./project-orb-scripts.js";

const orbScriptRefusals = [
  { status: 403, schema: ProjectOrbScriptsForbiddenResponseSchema },
  { status: 400, schema: ProjectOrbScriptsInvalidRequestResponseSchema },
  { status: 404, schema: ProjectOrbScriptsNotFoundResponseSchema },
  {
    status: 503,
    schema: ProjectOrbScriptsPersistenceUnavailableResponseSchema,
  },
];

export const GetProjectOrbScriptsEndpoint = defineEndpoint({
  id: "projects.orbScripts.get",
  summary: "Read a Project's Orb scripts",
  method: "GET",
  path: "/v1/projects/:projectId/orb-scripts",
  params: ProjectOrbScriptsParamsSchema,
  success: GetProjectOrbScriptsResponseSchema,
  refusals: orbScriptRefusals,
});

export const UpdateProjectOrbScriptEndpoint = defineEndpoint({
  id: "projects.orbScripts.update",
  summary: "Save one of a Project's Orb scripts",
  method: "PUT",
  path: "/v1/projects/:projectId/orb-scripts/:kind",
  params: UpdateProjectOrbScriptParamsSchema,
  body: UpdateProjectOrbScriptRequestSchema,
  success: UpdateProjectOrbScriptResponseSchema,
  refusals: orbScriptRefusals,
});
