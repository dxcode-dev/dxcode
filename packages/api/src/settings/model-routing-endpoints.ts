import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  CatalogResponseSchema,
  ConnectionParamsSchema,
  ConnectionResponseSchema,
  CreateConnectionRequestSchema,
  DeleteConnectionResponseSchema,
  ListConnectionsResponseSchema,
  ModelRoutingPersonalPath,
  ModelRoutingWorkspacePath,
  ModeParamsSchema,
  ModelRoutingRateLimitedResponseSchema,
  modelRoutingRefusals,
  ProfileResponseSchema,
  PutModeRequestSchema,
  ReorderConnectionsRequestSchema,
  ReorderConnectionsResponseSchema,
  SetClaudePlanRequestSchema,
  SetConnectionEnabledRequestSchema,
  UpdateConnectionRequestSchema,
  WorkspaceModelRoutingParamsSchema,
} from "./model-routing.js";

/**
 * Settings → Models endpoints: connections, the catalog, and mode profile
 * changes. In their own module, because the Thread page loads
 * `model-routing.ts` for its routing reads and never calls these
 * (wiki/headless-client.md).
 */

/** Refusals of the endpoints that check a connection's key (#2688). */
const connectionCheckRefusals = [
  ...modelRoutingRefusals,
  { status: 429, schema: ModelRoutingRateLimitedResponseSchema },
];

// Endpoints ---------------------------------------------------------------

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
  refusals: connectionCheckRefusals,
});

export const CreateWorkspaceModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.workspace.createConnection",
  method: "POST",
  path: `${ModelRoutingWorkspacePath}/connections`,
  params: WorkspaceModelRoutingParamsSchema,
  body: CreateConnectionRequestSchema,
  success: ConnectionResponseSchema,
  refusals: connectionCheckRefusals,
});

export const UpdatePersonalModelConnectionEndpoint = defineEndpoint({
  id: "modelRouting.personal.updateConnection",
  method: "PATCH",
  path: `${ModelRoutingPersonalPath}/connections/:connectionId`,
  params: ConnectionParamsSchema,
  body: UpdateConnectionRequestSchema,
  success: ConnectionResponseSchema,
  refusals: connectionCheckRefusals,
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
  refusals: connectionCheckRefusals,
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
  refusals: connectionCheckRefusals,
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
  refusals: connectionCheckRefusals,
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

export const PutPersonalProfileModeEndpoint = defineEndpoint({
  id: "modelRouting.personal.putProfileMode",
  method: "PUT",
  path: `${ModelRoutingPersonalPath}/profile/modes/:mode`,
  params: ModeParamsSchema,
  body: PutModeRequestSchema,
  success: ProfileResponseSchema,
  refusals: modelRoutingRefusals,
});

export const PutWorkspaceProfileModeEndpoint = defineEndpoint({
  id: "modelRouting.workspace.putProfileMode",
  method: "PUT",
  path: `${ModelRoutingWorkspacePath}/profile/modes/:mode`,
  params: Schema.Struct({
    ...WorkspaceModelRoutingParamsSchema.fields,
    ...ModeParamsSchema.fields,
  }),
  body: PutModeRequestSchema,
  success: ProfileResponseSchema,
  refusals: modelRoutingRefusals,
});

export const ResetPersonalProfileModeEndpoint = defineEndpoint({
  id: "modelRouting.personal.resetProfileMode",
  method: "DELETE",
  path: `${ModelRoutingPersonalPath}/profile/modes/:mode`,
  params: ModeParamsSchema,
  success: ProfileResponseSchema,
  refusals: modelRoutingRefusals,
});

export const ResetWorkspaceProfileModeEndpoint = defineEndpoint({
  id: "modelRouting.workspace.resetProfileMode",
  method: "DELETE",
  path: `${ModelRoutingWorkspacePath}/profile/modes/:mode`,
  params: Schema.Struct({
    ...WorkspaceModelRoutingParamsSchema.fields,
    ...ModeParamsSchema.fields,
  }),
  success: ProfileResponseSchema,
  refusals: modelRoutingRefusals,
});
