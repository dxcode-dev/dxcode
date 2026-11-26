import { ProjectId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  SourceControlDeniedResponseSchema,
  SourceControlProviderFailureResponseSchema,
} from "../source-control/errors.js";
import {
  CreateProjectForbiddenResponseSchema,
  CreateProjectInvalidRequestResponseSchema,
  CreateProjectNameConflictResponseSchema,
  CreateProjectPersistenceUnavailableResponseSchema,
  CreateProjectPolicyDeniedResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateProjectRunnerUnavailableResponseSchema,
} from "./create-project.js";
import {
  DeleteProjectInvalidRequestResponseSchema,
  DeleteProjectNameMismatchResponseSchema,
  DeleteProjectNotFoundResponseSchema,
  DeleteProjectParamsSchema,
  DeleteProjectPersistenceUnavailableResponseSchema,
  DeleteProjectRequestSchema,
  DeleteProjectResponseSchema,
} from "./delete-project.js";
import {
  MoveProjectForbiddenResponseSchema,
  MoveProjectInvalidRequestResponseSchema,
  MoveProjectNameConflictResponseSchema,
  MoveProjectNotFoundResponseSchema,
  MoveProjectParamsSchema,
  MoveProjectPersistenceUnavailableResponseSchema,
  MoveProjectRequestSchema,
  MoveProjectResponseSchema,
} from "./move-project.js";
import {
  RebindProjectSourceForbiddenResponseSchema,
  RebindProjectSourceInvalidRequestResponseSchema,
  RebindProjectSourceNotFoundResponseSchema,
  RebindProjectSourceParamsSchema,
  RebindProjectSourcePersistenceUnavailableResponseSchema,
  RebindProjectSourceRequestSchema,
  RebindProjectSourceResponseSchema,
} from "./rebind-project-source.js";
import {
  ProjectIconNotImageResponseSchema,
  ProjectIconTooLargeResponseSchema,
  UpdateProjectInvalidRequestResponseSchema,
  UpdateProjectNameConflictResponseSchema,
  UpdateProjectNotFoundResponseSchema,
  UpdateProjectPersistenceUnavailableResponseSchema,
  UpdateProjectPolicyDeniedResponseSchema,
  UpdateProjectResponseSchema,
  UpdateProjectRunnerUnavailableResponseSchema,
} from "./update-project.js";
import {
  UpdateProjectParamsSchema,
  UpdateProjectRequestSchema,
} from "./update-project-request.js";

export const CreateProjectEndpoint = defineEndpoint({
  id: "projects.create",
  summary: "Create a Project",
  method: "POST",
  path: "/v1/projects",
  body: CreateProjectRequestSchema,
  success: CreateProjectResponseSchema,
  successStatus: 201,
  refusals: [
    { status: 403, schema: CreateProjectForbiddenResponseSchema },
    { status: 400, schema: CreateProjectInvalidRequestResponseSchema },
    { status: 409, schema: CreateProjectNameConflictResponseSchema },
    { status: 503, schema: CreateProjectPersistenceUnavailableResponseSchema },
    { status: 403, schema: CreateProjectPolicyDeniedResponseSchema },
    { status: 409, schema: CreateProjectRunnerUnavailableResponseSchema },
    { status: 409, schema: SourceControlDeniedResponseSchema },
    { status: 503, schema: SourceControlProviderFailureResponseSchema },
  ],
});

export const UpdateProjectEndpoint = defineEndpoint({
  id: "projects.update",
  summary: "Change a Project",
  method: "PATCH",
  path: "/v1/projects/:projectId",
  params: UpdateProjectParamsSchema,
  body: UpdateProjectRequestSchema,
  success: UpdateProjectResponseSchema,
  refusals: [
    { status: 400, schema: UpdateProjectInvalidRequestResponseSchema },
    { status: 409, schema: UpdateProjectNameConflictResponseSchema },
    { status: 404, schema: UpdateProjectNotFoundResponseSchema },
    { status: 503, schema: UpdateProjectPersistenceUnavailableResponseSchema },
    { status: 403, schema: UpdateProjectPolicyDeniedResponseSchema },
    { status: 409, schema: UpdateProjectRunnerUnavailableResponseSchema },
  ],
});

/**
 * `PUT /v1/projects/:projectId/icon`: the image's bytes, with the Project
 * revision the person saw in the `x-project-revision` header.
 */
export const UploadProjectIconEndpoint = defineEndpoint({
  id: "projects.uploadIcon",
  summary: "Upload a Project's icon",
  method: "PUT",
  path: "/v1/projects/:projectId/icon",
  params: Schema.Struct({ projectId: ProjectId }),
  upload: "bytes",
  success: UpdateProjectResponseSchema,
  refusals: [
    { status: 415, schema: ProjectIconNotImageResponseSchema },
    { status: 413, schema: ProjectIconTooLargeResponseSchema },
    { status: 400, schema: UpdateProjectInvalidRequestResponseSchema },
    { status: 404, schema: UpdateProjectNotFoundResponseSchema },
    { status: 503, schema: UpdateProjectPersistenceUnavailableResponseSchema },
  ],
});

export const DeleteProjectEndpoint = defineEndpoint({
  id: "projects.delete",
  summary: "Delete a Project",
  method: "POST",
  path: "/v1/projects/:projectId/delete",
  params: DeleteProjectParamsSchema,
  body: DeleteProjectRequestSchema,
  success: DeleteProjectResponseSchema,
  refusals: [
    { status: 400, schema: DeleteProjectInvalidRequestResponseSchema },
    { status: 400, schema: DeleteProjectNameMismatchResponseSchema },
    { status: 404, schema: DeleteProjectNotFoundResponseSchema },
    { status: 503, schema: DeleteProjectPersistenceUnavailableResponseSchema },
  ],
});

export const MoveProjectEndpoint = defineEndpoint({
  id: "projects.move",
  summary: "Move a Project to another scope",
  method: "POST",
  path: "/v1/projects/:projectId/move",
  params: MoveProjectParamsSchema,
  body: MoveProjectRequestSchema,
  success: MoveProjectResponseSchema,
  refusals: [
    { status: 403, schema: MoveProjectForbiddenResponseSchema },
    { status: 400, schema: MoveProjectInvalidRequestResponseSchema },
    { status: 409, schema: MoveProjectNameConflictResponseSchema },
    { status: 404, schema: MoveProjectNotFoundResponseSchema },
    { status: 503, schema: MoveProjectPersistenceUnavailableResponseSchema },
  ],
});

export const RebindProjectSourceEndpoint = defineEndpoint({
  id: "projects.rebindSource",
  summary: "Point a Project at another repository",
  method: "PUT",
  path: "/v1/projects/:projectId/source",
  params: RebindProjectSourceParamsSchema,
  body: RebindProjectSourceRequestSchema,
  success: RebindProjectSourceResponseSchema,
  refusals: [
    { status: 403, schema: RebindProjectSourceForbiddenResponseSchema },
    { status: 400, schema: RebindProjectSourceInvalidRequestResponseSchema },
    { status: 404, schema: RebindProjectSourceNotFoundResponseSchema },
    {
      status: 503,
      schema: RebindProjectSourcePersistenceUnavailableResponseSchema,
    },
    { status: 409, schema: SourceControlDeniedResponseSchema },
    { status: 503, schema: SourceControlProviderFailureResponseSchema },
  ],
});
