import { defineEndpoint } from "../http/endpoint.js";
import {
  GetProjectRepositoryBrowseResponseSchema,
  ProjectRepositoryBrowseInvalidRequestResponseSchema,
  ProjectRepositoryBrowseNotFoundResponseSchema,
  ProjectRepositoryBrowseParamsSchema,
  ProjectRepositoryBrowsePersistenceUnavailableResponseSchema,
  ProjectRepositoryBrowseQuerySchema,
} from "./project-repository-browse.js";

export const GetProjectRepositoryBrowseEndpoint = defineEndpoint({
  id: "projects.repository.browse",
  summary: "Browse a Project's repository",
  method: "GET",
  path: "/v1/projects/:projectId/repository",
  params: ProjectRepositoryBrowseParamsSchema,
  query: ProjectRepositoryBrowseQuerySchema,
  success: GetProjectRepositoryBrowseResponseSchema,
  refusals: [
    {
      status: 400,
      schema: ProjectRepositoryBrowseInvalidRequestResponseSchema,
    },
    { status: 404, schema: ProjectRepositoryBrowseNotFoundResponseSchema },
    {
      status: 503,
      schema: ProjectRepositoryBrowsePersistenceUnavailableResponseSchema,
    },
  ],
});
