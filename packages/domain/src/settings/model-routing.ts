import { Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { WorkspaceId } from "./workspace.js";

export const MAX_MODEL_CONNECTIONS_PER_SCOPE = 20;
export const MAX_CONNECTION_MODELS = 100;
export const MAX_CONNECTION_HEADERS = 32;

/**
 * Canonical pi-ai catalog id in `provider/model` form. The provider segment
 * carries no slashes; the model segment may (e.g.
 * `cloudflare/@cf/zai-org/glm-5.3-flash`).
 */
export const ModelId = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(385),
  Schema.isPattern(/^[^\s/]+\/[^\s]+$/),
).pipe(Schema.brand("@dx/ModelId"));

export type ModelId = typeof ModelId.Type;

export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevel = typeof ThinkingLevel.Type;

export const ModeId = Schema.Literals(["low", "medium", "high", "ultra"]);

export type ModeId = typeof ModeId.Type;

export const MODE_IDS = ["low", "medium", "high", "ultra"] as const;

/** Only the `default` profile exists; the id stays so a later builder is additive. */
export const ProfileId = Schema.Literal("default");

export type ProfileId = typeof ProfileId.Type;

export const DEFAULT_PROFILE_ID: ProfileId = "default";

export const ConnectionKind = Schema.Literals([
  "subscription",
  "provider",
  "custom",
  "deployment",
]);

export type ConnectionKind = typeof ConnectionKind.Type;

export const CustomApiFormat = Schema.Literals([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

export type CustomApiFormat = typeof CustomApiFormat.Type;

/**
 * Path each custom format's SDK appends to the connection base URL. The
 * OpenAI SDK adds no version segment; the Anthropic SDK adds its own `/v1`.
 */
const CUSTOM_ENDPOINT_PATHS: Readonly<Record<CustomApiFormat, string>> = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages",
};

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

/**
 * The base URL a custom format's SDK must receive, from whatever the user
 * typed: an API root, a root ending in the SDK's own version segment, or a
 * pasted full endpoint. Inference, health checks, and previews all use this
 * one derivation.
 */
export const normalizeCustomModelBaseUrl = (
  format: CustomApiFormat,
  input: string,
): string => {
  let base = trimTrailingSlashes(input.trim());
  const path = CUSTOM_ENDPOINT_PATHS[format];
  if (base.toLowerCase().endsWith(path)) base = base.slice(0, -path.length);
  if (format === "anthropic-messages" && base.toLowerCase().endsWith("/v1"))
    base = base.slice(0, -"/v1".length);
  return trimTrailingSlashes(base);
};

/**
 * A saved URL to keep when only the format changes. A full endpoint pasted for
 * the previous format loses that format's path (Anthropic keeps its `/v1`);
 * any other URL, including proxy paths, is kept as typed.
 */
export const customModelBaseUrlForFormatChange = (
  previous: CustomApiFormat,
  input: string,
): string => {
  const base = trimTrailingSlashes(input.trim());
  if (!base.toLowerCase().endsWith(CUSTOM_ENDPOINT_PATHS[previous]))
    return input;
  const path =
    previous === "anthropic-messages"
      ? "/messages"
      : CUSTOM_ENDPOINT_PATHS[previous];
  return base.slice(0, -path.length);
};

/** The exact inference endpoint dx will call for a custom connection. */
export const customModelEndpoint = (
  format: CustomApiFormat,
  input: string,
): string =>
  `${normalizeCustomModelBaseUrl(format, input)}${CUSTOM_ENDPOINT_PATHS[format]}`;

export const ModelConnectionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/ModelConnectionId"));

export type ModelConnectionId = typeof ModelConnectionId.Type;

export const ModelCredentialId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/ModelCredentialId"));

export type ModelCredentialId = typeof ModelCredentialId.Type;

export const ModelProviderId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
).pipe(Schema.brand("@dx/ModelProviderId"));

export type ModelProviderId = typeof ModelProviderId.Type;

export const ModelConnectionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
).pipe(Schema.brand("@dx/ModelConnectionName"));

export type ModelConnectionName = typeof ModelConnectionName.Type;

export const ModelConnectionHealth = Schema.Struct({
  state: Schema.Literals(["untested", "healthy", "unhealthy"]),
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  checkedAt: Schema.optional(Timestamp),
});

export type ModelConnectionHealth = typeof ModelConnectionHealth.Type;

export const untestedModelConnectionHealth = (): ModelConnectionHealth => ({
  state: "untested",
  code: "NOT_TESTED",
});

export const ModelConnectionHeader = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  value: Schema.String.check(Schema.isMaxLength(4_096)),
});

export type ModelConnectionHeader = typeof ModelConnectionHeader.Type;

/**
 * A model a `custom` connection serves. `canonical` is the dx-facing
 * `provider/model` id; `upstream` is the id the upstream API expects when it
 * differs from the canonical catalog id. An empty list means the connection
 * serves its provider's whole catalog.
 */
export const ConnectionModel = Schema.Struct({
  canonical: ModelId,
  upstream: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
});

export type ConnectionModel = typeof ConnectionModel.Type;

export const PersonalModelConnectionTarget = Schema.Struct({
  scope: Schema.Literal("personal"),
  id: UserId,
});

export const WorkspaceModelConnectionTarget = Schema.Struct({
  scope: Schema.Literal("workspace"),
  id: WorkspaceId,
});

export const ModelConnectionTarget = Schema.Union([
  PersonalModelConnectionTarget,
  WorkspaceModelConnectionTarget,
]);

export type ModelConnectionTarget = typeof ModelConnectionTarget.Type;

export const StoredModelConnection = Schema.Struct({
  id: ModelConnectionId,
  target: ModelConnectionTarget,
  name: ModelConnectionName,
  kind: ConnectionKind,
  providerId: ModelProviderId,
  baseUrl: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  ),
  format: Schema.optional(CustomApiFormat),
  fields: Schema.Record(Schema.String, Schema.String).check(
    Schema.isMaxProperties(32),
  ),
  headers: Schema.Array(ModelConnectionHeader).check(
    Schema.isMaxLength(MAX_CONNECTION_HEADERS),
  ),
  models: Schema.Array(ConnectionModel).check(
    Schema.isMaxLength(MAX_CONNECTION_MODELS),
  ),
  enabled: Schema.Boolean,
  priority: Schema.Int,
  health: ModelConnectionHealth,
  credentialId: Schema.optional(ModelCredentialId),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
  .check(
    Schema.makeFilter(
      (connection) =>
        connection.kind !== "custom" ||
        (connection.baseUrl !== undefined && connection.format !== undefined),
      {
        identifier: "CustomModelConnectionEndpoint",
        description: "Custom connections require both baseUrl and format.",
      },
    ),
  )
  .check(
    Schema.makeFilter(
      (connection) =>
        connection.format === undefined || connection.kind === "custom",
      {
        identifier: "ModelConnectionFormatKind",
        description: "format applies to custom connections only.",
      },
    ),
  )
  .check(
    Schema.makeFilter(
      (connection) =>
        connection.baseUrl === undefined ||
        connection.kind === "custom" ||
        connection.kind === "provider",
      {
        identifier: "ModelConnectionBaseUrlKind",
        description: "baseUrl applies to custom and provider connections only.",
      },
    ),
  )
  .check(
    Schema.makeFilter(
      (connection) =>
        connection.models.length === 0 || connection.kind === "custom",
      {
        identifier: "ModelConnectionModelsKind",
        description:
          "Only custom connections declare explicit served models; an empty list serves the provider's whole catalog.",
      },
    ),
  )
  .check(
    Schema.makeFilter(
      (connection) =>
        connection.credentialId === undefined ||
        connection.kind !== "deployment",
      {
        identifier: "DeploymentModelConnectionCredential",
        description: "Deployment connections never carry user credentials.",
      },
    ),
  );

export type StoredModelConnection = typeof StoredModelConnection.Type;

export const ModelCapabilities = Schema.Struct({
  contextWindow: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reasoning: Schema.Boolean,
  vision: Schema.Boolean,
});

export type ModelCapabilities = typeof ModelCapabilities.Type;

export const ModelCost = Schema.Struct({
  input: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheRead: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheWrite: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ModelCost = typeof ModelCost.Type;

export const ModeSlot = Schema.Struct({
  model: ModelId,
  thinking: ThinkingLevel,
});

export type ModeSlot = typeof ModeSlot.Type;

export const ModeConfig = Schema.Struct({
  agent: ModeSlot,
  oracle: Schema.optional(ModeSlot),
  subagents: Schema.optional(ModeSlot),
});

export type ModeConfig = typeof ModeConfig.Type;

export const Profile = Schema.Struct({
  id: ProfileId,
  modes: Schema.Struct({
    low: ModeConfig,
    medium: ModeConfig,
    high: ModeConfig,
    ultra: ModeConfig,
  }),
});

export type Profile = typeof Profile.Type;

/**
 * One stored row per (userId, profileId, mode) override; an absent row means
 * the mode resolves from the shipped default profile.
 */
export const ModeProfileOverride = Schema.Struct({
  userId: UserId,
  profileId: ProfileId,
  mode: ModeId,
  config: ModeConfig,
  updatedAt: Timestamp,
});

export type ModeProfileOverride = typeof ModeProfileOverride.Type;

export const ThreadModeSelection = Schema.Struct({
  kind: Schema.Literal("mode"),
  profileId: ProfileId,
  mode: ModeId,
});

export const ThreadModelPin = Schema.Struct({
  kind: Schema.Literal("model"),
  model: ModelId,
});

export const ThreadModelSelection = Schema.Union([
  ThreadModeSelection,
  ThreadModelPin,
]);

export type ThreadModelSelection = typeof ThreadModelSelection.Type;

export const defaultThreadModelSelection = (): ThreadModelSelection => ({
  kind: "mode",
  profileId: "default",
  mode: "medium",
});

/**
 * Resolver output, computed per submission and never persisted as truth.
 * Phase 2 fills this in; it is declared now so the frozen shape is shared.
 */
export interface ResolvedSubmissionModel {
  readonly model: ModelId;
  readonly upstreamModel: string;
  readonly thinking: ThinkingLevel;
  readonly connection: {
    readonly id: ModelConnectionId;
    readonly scope: "personal" | "workspace";
    readonly kind: ConnectionKind;
    readonly providerId: ModelProviderId;
    readonly name: string;
  };
  readonly capabilities: {
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    readonly reasoning: boolean;
    readonly vision: boolean;
  };
}

export class ModelNotServed extends Schema.TaggedError<ModelNotServed>()(
  "ModelNotServed",
  {
    model: ModelId,
    reason: Schema.Literals(["no-connection", "disabled", "unknown-model"]),
  },
) {}
