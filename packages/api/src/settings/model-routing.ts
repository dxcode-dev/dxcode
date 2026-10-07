import {
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

export const ConnectionDataSchema = Schema.Struct({
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
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

export type ConnectionData = typeof ConnectionDataSchema.Type;

export const ListConnectionsResponseSchema = successResponse(
  Schema.Struct({ connections: Schema.Array(ConnectionDataSchema) }),
);

export const CreateConnectionRequestSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
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
  name: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  ),
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
  transport: Schema.Literals(["proxy", "in-do", "subscription", "binding"]),
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
  source: Schema.Literals(["default", "override", "workspace"]),
  served: Schema.Boolean,
  servingConnectionName: Schema.NullOr(Schema.String),
});

export const ServedModelChoiceDataSchema = Schema.Struct({
  canonical: CanonicalModelIdSchema,
  name: Schema.String,
  connectionId: ModelConnectionId,
  connectionName: Schema.String,
  contextWindow: Schema.Int,
  reasoning: Schema.Boolean,
  vision: Schema.Boolean,
});

export const ChoicesResponseSchema = successResponse(
  Schema.Struct({
    modes: Schema.Array(ModeChoiceDataSchema),
    models: Schema.Array(ServedModelChoiceDataSchema),
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
