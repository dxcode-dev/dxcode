import { defineEndpoint } from "../http/endpoint.js";
import {
  GetProjectInvalidRequestResponseSchema,
  GetProjectNotFoundResponseSchema,
  GetProjectParamsSchema,
  GetProjectPersistenceUnavailableResponseSchema,
  GetProjectResponseSchema,
} from "./get-project.js";
import {
  ListProjectsInvalidRequestResponseSchema,
  ListProjectsPersistenceUnavailableResponseSchema,
  ListProjectsQuerySchema,
  ListProjectsResponseSchema,
} from "./list-projects.js";

export const ListProjectsEndpoint = defineEndpoint({
  id: "projects.list",
  summary: "List Projects",
  method: "GET",
  path: "/v1/projects",
  query: ListProjectsQuerySchema,
  success: ListProjectsResponseSchema,
  refusals: [
    { status: 400, schema: ListProjectsInvalidRequestResponseSchema },
    { status: 503, schema: ListProjectsPersistenceUnavailableResponseSchema },
  ],
});

export const GetProjectEndpoint = defineEndpoint({
  id: "projects.get",
  summary: "Read a Project",
  method: "GET",
  path: "/v1/projects/:projectId",
  params: GetProjectParamsSchema,
  success: GetProjectResponseSchema,
  refusals: [
    { status: 400, schema: GetProjectInvalidRequestResponseSchema },
    { status: 404, schema: GetProjectNotFoundResponseSchema },
    { status: 503, schema: GetProjectPersistenceUnavailableResponseSchema },
  ],
});
