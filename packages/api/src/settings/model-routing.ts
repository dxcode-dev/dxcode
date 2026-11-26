import {
  ClaudePlanUsage,
  type ConnectionKind,
  CustomApiFormat,
  type ModeConfig,
  ModeId,
  type ModelConnectionHeader,
  ModelConnectionHealth,
  ModelConnectionId,
  type ModelId,
  type ModelProviderId,
  ThinkingLevel,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

// Canonical catalog id in `provider/model` form (see @dx/domain ModelId).
export const CanonicalModelIdSchema = Schema.String.check(
  Schema.isPattern(/^[^\s/]+\/[^\s]+$/),
);

export const ConnectionKindSchema = Schema.Literals([
  "subscription",
  "provider",
  "custom",
  "deployment",
]);

export const ConnectionModelDataSchema = Schema.Struct({
  canonical: CanonicalModelIdSchema,
  upstream: Schema.optional(Schema.String),
});

export const ConnectionHeaderDataSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  value: Schema.String.check(Schema.isMaxLength(4_096)),
});

export const MaskedHeaderDataSchema = Schema.Struct({
  name: Schema.String,
  /** `••••` + last four characters; never the plaintext value. */
  masked: Schema.String,
});

/**
 * A Claude Pro/Max connection's plan: whether Claude Code may keep working on
 * the account's paid extra usage once a plan limit is used up, and the latest
 * limits Anthropic reported to a Claude Code run or title call.
 */
export const ClaudePlanDataSchema = Schema.Struct({
  allowExtraUsage: Schema.Boolean,
  usage: Schema.optional(ClaudePlanUsage),
});

export type ClaudePlanData = typeof ClaudePlanDataSchema.Type;

const ConnectionDataSchema = Schema.Struct({
  id: ModelConnectionId,
  name: Schema.String,
  kind: ConnectionKindSchema,
  providerId: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  format: Schema.optional(CustomApiFormat),
  fields: Schema.Record(Schema.String, Schema.String),
  headers: Schema.Array(MaskedHeaderDataSchema),
  models: Schema.Array(ConnectionModelDataSchema),
  enabled: Schema.Boolean,
  priority: Schema.Int,
  health: ModelConnectionHealth,
  credential: Schema.optional(
    Schema.Struct({
      present: Schema.Boolean,
      /** Last four characters of the stored key, when present. */
      tail: Schema.optional(Schema.String),
    }),
  ),
  /** `"catalog"` when the connection serves the provider's whole catalog. */
  serves: Schema.Literals(["catalog", "declared"]),
  /** Set only for a Claude Pro/Max connection. */
  claudePlan: Schema.optional(ClaudePlanDataSchema),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

export type ConnectionData = typeof ConnectionDataSchema.Type;

export const ListConnectionsResponseSchema = successResponse(
  Schema.Struct({ connections: Schema.Array(ConnectionDataSchema) }),
);

export const CreateConnectionRequestSchema = Schema.Struct({
  /** Validated by the service, which names the field when it is invalid. */
  name: Schema.String,
  kind: ConnectionKindSchema,
  providerId: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  format: Schema.optional(CustomApiFormat),
  fields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  headers: Schema.optional(Schema.Array(ConnectionHeaderDataSchema)),
  models: Schema.optional(Schema.Array(ConnectionModelDataSchema)),
  apiKey: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  ),
  enabled: Schema.optional(Schema.Boolean),
});

export const ConnectionResponseSchema = successResponse(ConnectionDataSchema);

export const UpdateConnectionRequestSchema = Schema.Struct({
  /** Validated by the service, which names the field when it is invalid. */
  name: Schema.optional(Schema.String),
  /** Set to null to restore a catalog provider's default endpoint; omit to keep. */
  baseUrl: Schema.optional(Schema.NullOr(Schema.String)),
  format: Schema.optional(CustomApiFormat),
  fields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  headers: Schema.optional(Schema.Array(ConnectionHeaderDataSchema)),
  models: Schema.optional(Schema.Array(ConnectionModelDataSchema)),
  /** Set to replace the stored key; omit to keep it. */
  apiKey: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  ),
});

export const SetConnectionEnabledRequestSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

export const SetClaudePlanRequestSchema = Schema.Struct({
  allowExtraUsage: Schema.Boolean,
});

export const ReorderConnectionsRequestSchema = Schema.Struct({
  orderedIds: Schema.Array(ModelConnectionId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
});

export const ReorderConnectionsResponseSchema = successResponse(
  Schema.Struct({ connections: Schema.Array(ConnectionDataSchema) }),
);

export const DeleteConnectionResponseSchema = successResponse(
  Schema.Struct({ deletedConnectionId: ModelConnectionId }),
);

export const ConnectionParamsSchema = Schema.Struct({
  connectionId: ModelConnectionId,
});

// Catalog -------------------------------------------------------------------

export const CatalogFieldDataSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  required: Schema.Boolean,
  secret: Schema.Boolean,
  placeholder: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

export const CatalogModelDataSchema = Schema.Struct({
  /** Canonical `provider/model` id. */
  id: CanonicalModelIdSchema,
  name: Schema.String,
  contextWindow: Schema.Int,
  maxOutputTokens: Schema.Int,
  reasoning: Schema.Boolean,
  vision: Schema.Boolean,
});

export const CatalogProviderDataSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** Which connection kind creates this provider. */
  connectionKind: ConnectionKindSchema,
  /** `proxy` = coordinator header-swap; `in-do` = adapter inside the DO. */
  transport: Schema.Literals([
    "proxy",
    "in-do",
    "subscription",
    "binding",
    "agent",
  ]),
  fields: Schema.Array(CatalogFieldDataSchema),
  models: Schema.Array(CatalogModelDataSchema),
});

export const CatalogResponseSchema = successResponse(
  Schema.Struct({ providers: Schema.Array(CatalogProviderDataSchema) }),
);

// Graph ---------------------------------------------------------------------

export const ModeGraphNodeDataSchema = Schema.Struct({
  mode: ModeId,
  config: Schema.Struct({
    model: CanonicalModelIdSchema,
    thinking: ThinkingLevel,
  }),
  /** The model catalog's display name for `config.model`. */
  modelName: Schema.String,
  source: Schema.Literals(["default", "override", "workspace"]),
  served: Schema.Boolean,
});

export const GraphConnectionNodeDataSchema = Schema.Struct({
  connectionId: ModelConnectionId,
  name: Schema.String,
  kind: ConnectionKindSchema,
  scope: Schema.Literals(["personal", "workspace"]),
  priority: Schema.Int,
  enabled: Schema.Boolean,
});

export const GraphEdgeDataSchema = Schema.Struct({
  mode: ModeId,
  model: CanonicalModelIdSchema,
  /** Null when no enabled connection serves the model. */
  connectionId: Schema.NullOr(ModelConnectionId),
});

export const GraphResponseSchema = successResponse(
  Schema.Struct({
    modes: Schema.Array(ModeGraphNodeDataSchema),
    connections: Schema.Array(GraphConnectionNodeDataSchema),
    edges: Schema.Array(GraphEdgeDataSchema),
  }),
);

// Choices (personal) ---------------------------------------------------------

export const ModeChoiceDataSchema = Schema.Struct({
  mode: ModeId,
  config: Schema.Struct({
    model: CanonicalModelIdSchema,
    thinking: ThinkingLevel,
  }),
  /** The model catalog's display name for `config.model`. */
  modelName: Schema.String,
  source: Schema.Literals(["default", "override", "workspace"]),
  served: Schema.Boolean,
  servingConnectionName: Schema.NullOr(Schema.String),
});

export const ServedModelChoiceDataSchema = Schema.Struct({
  canonical: CanonicalModelIdSchema,
  /** The model catalog's display name. */
  name: Schema.String,
  connectionId: ModelConnectionId,
  /** The connection's name as people see it. */
  connectionName: Schema.String,
  /** What the connection is, for the picker's group mark. */
  connectionKind: Schema.optional(ConnectionKindSchema),
  connectionProviderId: Schema.optional(Schema.String),
  connectionScope: Schema.optional(Schema.Literals(["personal", "workspace"])),
  contextWindow: Schema.Int,
  reasoning: Schema.Boolean,
  vision: Schema.Boolean,
});

/**
 * A connected Claude Pro/Max plan a new Claude Code Thread can be bound to,
 * in routing order, with the limits Claude Code runs last reported on it.
 */
export const ClaudePlanChoiceDataSchema = Schema.Struct({
  connectionId: ModelConnectionId,
  name: Schema.String,
  enabled: Schema.Boolean,
  allowExtraUsage: Schema.Boolean,
  usage: Schema.optional(ClaudePlanUsage),
  /** Threads on the plan working now or bound in the last few minutes. */
  load: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type ClaudePlanChoiceData = typeof ClaudePlanChoiceDataSchema.Type;

export const ChoicesResponseSchema = successResponse(
  Schema.Struct({
    modes: Schema.Array(ModeChoiceDataSchema),
    models: Schema.Array(ServedModelChoiceDataSchema),
    claudePlans: Schema.Array(ClaudePlanChoiceDataSchema),
    /**
     * Models the deployment names but does not serve now, such as a dx
     * model whose upstream an admin turned off, so a Thread on one still
     * shows its name ("dx Flash", not "flash").
     */
    unservedModels: Schema.optional(
      Schema.Array(
        Schema.Struct({
          canonical: CanonicalModelIdSchema,
          name: Schema.String,
        }),
      ),
    ),
  }),
);

// Profile (personal and workspace) ----------------------------------------------------------

export const ModeSlotDataSchema = Schema.Struct({
  model: CanonicalModelIdSchema,
  thinking: ThinkingLevel,
});

export const ModeConfigDataSchema = Schema.Struct({
  agent: ModeSlotDataSchema,
  oracle: Schema.optional(ModeSlotDataSchema),
  subagents: Schema.optional(ModeSlotDataSchema),
});

/**
 * `override` is the scope's own Mode Dial value. In a personal profile,
 * `workspace` is inherited from the user's workspace Mode Dial.
 */
export const ProfileModeDataSchema = Schema.Struct({
  config: ModeConfigDataSchema,
  source: Schema.Literals(["default", "override", "workspace"]),
});

export const ProfileResponseSchema = successResponse(
  Schema.Struct({
    id: Schema.Literal("default"),
    modes: Schema.Struct({
      low: ProfileModeDataSchema,
      medium: ProfileModeDataSchema,
      high: ProfileModeDataSchema,
      ultra: ProfileModeDataSchema,
    }),
  }),
);

export const PutModeRequestSchema = ModeConfigDataSchema;

export const ModeParamsSchema = Schema.Struct({ mode: ModeId });

// Errors ----------------------------------------------------------------------

export const WorkspaceModelRoutingParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const ModelRoutingInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_MODEL_ROUTING_REQUEST"),
    message: Schema.Literal("Model routing validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const ModelRoutingForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const ModelRoutingMutationForbiddenResponseSchema = errorResponse(
  "MODEL_ROUTING_MUTATION_FORBIDDEN",
  "This workspace role has read-only model routing access.",
);

export const ModelConnectionNotFoundResponseSchema = errorResponse(
  "MODEL_CONNECTION_NOT_FOUND",
  "Model connection not found.",
);

export const ModelRoutingUnavailableResponseSchema = errorResponse(
  "MODEL_ROUTING_UNAVAILABLE",
  "Model routing is not configured.",
);

export const ModelRoutingErrorResponseSchema = Schema.Union([
  ModelRoutingInvalidRequestResponseSchema,
  ModelRoutingForbiddenResponseSchema,
  ModelRoutingMutationForbiddenResponseSchema,
  ModelConnectionNotFoundResponseSchema,
  ModelRoutingUnavailableResponseSchema,
]);

// Endpoints the Thread page calls on first load ----------------------------

export const modelRoutingRefusals = [
  { status: 400, schema: ModelRoutingInvalidRequestResponseSchema },
  { status: 403, schema: ModelRoutingForbiddenResponseSchema },
  { status: 403, schema: ModelRoutingMutationForbiddenResponseSchema },
  { status: 404, schema: ModelConnectionNotFoundResponseSchema },
  { status: 503, schema: ModelRoutingUnavailableResponseSchema },
];

export const ModelRoutingPersonalPath = "/v1/settings/personal/model-routing";
export const ModelRoutingWorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/model-routing";

export const GetPersonalModelRoutingGraphEndpoint = defineEndpoint({
  id: "modelRouting.personal.graph",
  method: "GET",
  path: `${ModelRoutingPersonalPath}/graph`,
  success: GraphResponseSchema,
  refusals: modelRoutingRefusals,
});

export const GetWorkspaceModelRoutingGraphEndpoint = defineEndpoint({
  id: "modelRouting.workspace.graph",
  method: "GET",
  path: `${ModelRoutingWorkspacePath}/graph`,
  params: WorkspaceModelRoutingParamsSchema,
  success: GraphResponseSchema,
  refusals: modelRoutingRefusals,
});

export const GetPersonalModelRoutingChoicesEndpoint = defineEndpoint({
  id: "modelRouting.personal.choices",
  method: "GET",
  path: `${ModelRoutingPersonalPath}/choices`,
  success: ChoicesResponseSchema,
  refusals: modelRoutingRefusals,
});

export const GetWorkspaceModelRoutingChoicesEndpoint = defineEndpoint({
  id: "modelRouting.workspace.choices",
  method: "GET",
  path: `${ModelRoutingWorkspacePath}/choices`,
  params: WorkspaceModelRoutingParamsSchema,
  success: ChoicesResponseSchema,
  refusals: modelRoutingRefusals,
});

export const GetPersonalModeProfileEndpoint = defineEndpoint({
  id: "modelRouting.personal.profile",
  method: "GET",
  path: `${ModelRoutingPersonalPath}/profile`,
  success: ProfileResponseSchema,
  refusals: modelRoutingRefusals,
});

export const GetWorkspaceModeProfileEndpoint = defineEndpoint({
  id: "modelRouting.workspace.profile",
  method: "GET",
  path: `${ModelRoutingWorkspacePath}/profile`,
  params: WorkspaceModelRoutingParamsSchema,
  success: ProfileResponseSchema,
  refusals: modelRoutingRefusals,
});

// Type aliases the web layer consumes.
export type ConnectionKindData = ConnectionKind;
export type CustomApiFormatData = CustomApiFormat;
export type ModeConfigData = ModeConfig;
export type ModelIdData = ModelId;
export type ModelProviderIdData = ModelProviderId;
export type ModelConnectionHeaderData = ModelConnectionHeader;
export type CatalogProviderData = typeof CatalogProviderDataSchema.Type;
export type CatalogData = (typeof CatalogResponseSchema.Type)["data"];
export type GraphData = (typeof GraphResponseSchema.Type)["data"];
export type ModeChoiceData = typeof ModeChoiceDataSchema.Type;
export type ServedModelChoiceData = typeof ServedModelChoiceDataSchema.Type;
export type ChoicesData = (typeof ChoicesResponseSchema.Type)["data"];
export type ModeConfigInput = typeof ModeConfigDataSchema.Type;
export type ProfileData = (typeof ProfileResponseSchema.Type)["data"];
