import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  CatalogResponseSchema,
  ConnectionParamsSchema,
  ConnectionResponseSchema,
  CreateConnectionRequestSchema,
  DeleteConnectionResponseSchema,
  ListConnectionsResponseSchema,
  ModelConnectionNotFoundResponseSchema,
  ModelRoutingForbiddenResponseSchema,
  ModelRoutingInvalidRequestResponseSchema,
  ModelRoutingMutationForbiddenResponseSchema,
  ModelRoutingUnavailableResponseSchema,
  ReorderConnectionsRequestSchema,
  ReorderConnectionsResponseSchema,
  SetClaudePlanRequestSchema,
  SetConnectionEnabledRequestSchema,
  UpdateConnectionRequestSchema,
  WorkspaceModelRoutingParamsSchema,
} from "./model-routing.js";

/**
 * The endpoints over `model-routing.ts`'s schemas. Apart from them, so code that
 * imports only the schemas (some on the Thread page's first load) does not
 * carry the endpoint definitions.
 */

// Endpoints ---------------------------------------------------------------

const modelRoutingRefusals = [
  { status: 400, schema: ModelRoutingInvalidRequestResponseSchema },
  { status: 403, schema: ModelRoutingForbiddenResponseSchema },
  { status: 403, schema: ModelRoutingMutationForbiddenResponseSchema },
  { status: 404, schema: ModelConnectionNotFoundResponseSchema },
  { status: 503, schema: ModelRoutingUnavailableResponseSchema },
];

const ModelRoutingPersonalPath = "/v1/settings/personal/model-routing";
const ModelRoutingWorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/model-routing";

export const GetPersonalModelCatalogEndpoint = defineEndpoint({
  id: "modelRouting.personal.catalog",
  method: "GET",
  path: `${ModelRoutingPersonalPath}/catalog`,
  success: CatalogResponseSchema,
  refusals: modelRoutingRefusals,
});

export const GetWorkspaceModelCatalogEndpoint = defineEndpoint({
  id: "modelRouting.workspace.catalog",
  method: "GET",
  path: `${ModelRoutingWorkspacePath}/catalog`,
  params: WorkspaceModelRoutingParamsSchema,
  success: CatalogResponseSchema,
  refusals: modelRoutingRefusals,
});

export const ListPersonalModelConnectionsEndpoint = defineEndpoint({
  id: "modelRouting.personal.listConnections",
  method: "GET",
  path: `${ModelRoutingPersonalPath}/connections`,
  success: ListConnectionsResponseSchema,
  refusals: modelRoutingRefusals,
});

export const ListWorkspaceModelConnectionsEndpoint = defineEndpoint({
  id: "modelRouting.workspace.listConnections",
  method: "GET",
  path: `${ModelRoutingWorkspacePath}/connections`,
  params: WorkspaceModelRoutingParamsSchema,
  success: ListConnectionsResponseSchema,
  refusals: modelRoutingRefusals,
});

export const CreatePersonalModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.personal.createConnection",
  method: "POST",
  path: `${ModelRoutingPersonalPath}/connections`,
  body: CreateConnectionRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const CreateWorkspaceModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.workspace.createConnection",
  method: "POST",
  path: `${ModelRoutingWorkspacePath}/connections`,
  params: WorkspaceModelRoutingParamsSchema,
  body: CreateConnectionRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const UpdatePersonalModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.personal.updateConnection",
  method: "PATCH",
  path: `${ModelRoutingPersonalPath}/connections/:connectionId`,
  params: ConnectionParamsSchema,
  body: UpdateConnectionRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const UpdateWorkspaceModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.workspace.updateConnection",
  method: "PATCH",
  path: `${ModelRoutingWorkspacePath}/connections/:connectionId`,
  params: Schema.Struct({
    ...WorkspaceModelRoutingParamsSchema.fields,
    ...ConnectionParamsSchema.fields,
  }),
  body: UpdateConnectionRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const SetPersonalModelConnectionEnabledEndpoint = defineEndpoint({
  id: "modelRouting.personal.setConnectionEnabled",
  method: "POST",
  path: `${ModelRoutingPersonalPath}/connections/:connectionId/enabled`,
  params: ConnectionParamsSchema,
  body: SetConnectionEnabledRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const SetWorkspaceModelConnectionEnabledEndpoint = defineEndpoint({
  id: "modelRouting.workspace.setConnectionEnabled",
  method: "POST",
  path: `${ModelRoutingWorkspacePath}/connections/:connectionId/enabled`,
  params: Schema.Struct({
    ...WorkspaceModelRoutingParamsSchema.fields,
    ...ConnectionParamsSchema.fields,
  }),
  body: SetConnectionEnabledRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const SetPersonalClaudePlanExtraUsageEndpoint = defineEndpoint({
  id: "modelRouting.personal.setClaudePlan",
  method: "POST",
  path: `${ModelRoutingPersonalPath}/connections/:connectionId/claude-plan`,
  params: ConnectionParamsSchema,
  body: SetClaudePlanRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const SetWorkspaceClaudePlanExtraUsageEndpoint = defineEndpoint({
  id: "modelRouting.workspace.setClaudePlan",
  method: "POST",
  path: `${ModelRoutingWorkspacePath}/connections/:connectionId/claude-plan`,
  params: Schema.Struct({
    ...WorkspaceModelRoutingParamsSchema.fields,
    ...ConnectionParamsSchema.fields,
  }),
  body: SetClaudePlanRequestSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const CheckPersonalModelConnectionAccessEndpoint = defineEndpoint({
  id: "modelRouting.personal.checkConnectionAccess",
  method: "POST",
  path: `${ModelRoutingPersonalPath}/connections/:connectionId/check-access`,
  params: ConnectionParamsSchema,
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const CheckWorkspaceModelConnectionAccessEndpoint = defineEndpoint({
  id: "modelRouting.workspace.checkConnectionAccess",
  method: "POST",
  path: `${ModelRoutingWorkspacePath}/connections/:connectionId/check-access`,
  params: Schema.Struct({
    ...WorkspaceModelRoutingParamsSchema.fields,
    ...ConnectionParamsSchema.fields,
  }),
  success: ConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const DeletePersonalModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.personal.deleteConnection",
  method: "DELETE",
  path: `${ModelRoutingPersonalPath}/connections/:connectionId`,
  params: ConnectionParamsSchema,
  success: DeleteConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const DeleteWorkspaceModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.workspace.deleteConnection",
  method: "DELETE",
  path: `${ModelRoutingWorkspacePath}/connections/:connectionId`,
  params: Schema.Struct({
    ...WorkspaceModelRoutingParamsSchema.fields,
    ...ConnectionParamsSchema.fields,
  }),
  success: DeleteConnectionResponseSchema,
  refusals: modelRoutingRefusals,
});

export const ReorderPersonalModelConnectionsEndpoint = defineEndpoint({
  id: "modelRouting.personal.reorderConnections",
  method: "POST",
  path: `${ModelRoutingPersonalPath}/connections/reorder`,
  body: ReorderConnectionsRequestSchema,
  success: ReorderConnectionsResponseSchema,
  refusals: modelRoutingRefusals,
});

export const ReorderWorkspaceModelConnectionsEndpoint = defineEndpoint({
  id: "modelRouting.workspace.reorderConnections",
  method: "POST",
  path: `${ModelRoutingWorkspacePath}/connections/reorder`,
  params: WorkspaceModelRoutingParamsSchema,
  body: ReorderConnectionsRequestSchema,
  success: ReorderConnectionsResponseSchema,
  refusals: modelRoutingRefusals,
});
