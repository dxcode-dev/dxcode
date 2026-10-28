import {
  ExecutionPauseResumePreserves,
  OrbProviderConnectionStatus,
  OrbProviderCredentials,
  OrbProviderField,
  OrbProviderId,
  OrbProviderPreparationProgress,
  PluginScope,
  ProjectId,
  RunnerProfileId,
  RunnerResources,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** Orb (Execution) providers, from `@dx/domain`'s provider list. */
export { OrbProviderId };

/** A size an account cannot run, with the provider's reason. */
export const OrbUnavailableSizeSchema = Schema.Struct({
  id: RunnerProfileId,
  reason: Schema.String,
});

export type OrbUnavailableSize = typeof OrbUnavailableSizeSchema.Type;

/**
 * A person's or workspace's own provider account. The credentials are
 * never returned.
 */
export const OrbProviderConnectionDataSchema = Schema.Struct({
  configuredAt: Schema.String,
  /** The provider account (E2B team, Cloudflare account), once known. */
  account: Schema.NullOr(Schema.String),
  /** Null in the local runtime, which never reaches the provider. */
  status: Schema.NullOr(OrbProviderConnectionStatus),
  /** What preparation is doing; null unless preparing. */
  progress: Schema.NullOr(OrbProviderPreparationProgress),
  /** Why preparation failed; null unless failed. */
  error: Schema.NullOr(Schema.String),
  /**
   * Preparing (or failed to prepare) a new version while new Threads keep
   * using the last ready one.
   */
  updating: Schema.Boolean,
  /**
   * Sizes this account cannot run (its plan refused them), from the
   * version new Threads use; empty until it is ready.
   */
  unavailableSizes: Schema.Array(OrbUnavailableSizeSchema),
});

export type OrbProviderConnectionData =
  typeof OrbProviderConnectionDataSchema.Type;

/** One Orb size a provider offers. */
export const OrbProviderSizeSchema = Schema.Struct({
  id: RunnerProfileId,
  label: Schema.String,
  resources: RunnerResources,
});

export type OrbProviderSize = typeof OrbProviderSizeSchema.Type;

export const OrbProviderDataSchema = Schema.Struct({
  id: OrbProviderId,
  displayName: Schema.String,
  /** One sentence: what connecting this provider takes. */
  description: Schema.String,
  /** The connection form; empty when no one can connect the provider. */
  fields: Schema.Array(OrbProviderField),
  sizes: Schema.Array(OrbProviderSizeSchema),
  pauseResume: Schema.NullOr(ExecutionPauseResumePreserves),
  /** The deployment provides this provider with its own account. */
  deployment: Schema.Boolean,
  /** This scope's own connection. */
  connection: Schema.NullOr(OrbProviderConnectionDataSchema),
  /** The workspace's connection, shown to a member on the personal page. */
  workspaceConnection: Schema.NullOr(OrbProviderConnectionDataSchema),
});

export type OrbProviderData = typeof OrbProviderDataSchema.Type;

/** One provider a Thread can start on, with whose account pays for it. */
export const OrbResolvedProviderSchema = Schema.Struct({
  providerId: OrbProviderId,
  scope: PluginScope,
  account: Schema.NullOr(Schema.String),
  status: OrbProviderConnectionStatus,
  /** Sizes this account cannot run; the Orb picker leaves them out. */
  unavailableSizes: Schema.Array(OrbUnavailableSizeSchema),
});

export type OrbResolvedProvider = typeof OrbResolvedProviderSchema.Type;

export const OrbProviderListDataSchema = Schema.Struct({
  scope: Schema.Literals(["personal", "workspace"]),
  canUpdate: Schema.Boolean,
  /** The local runtime ignores personal and workspace connections. */
  localRuntime: Schema.Boolean,
  providers: Schema.Array(OrbProviderDataSchema),
  /**
   * Whether members' own connections apply on workspace projects: both the
   * workspace's general plugin flag and its Orb opt-in. Null without a
   * workspace.
   */
  personalKeysOnWorkspaceProjects: Schema.NullOr(
    Schema.Struct({
      allowed: Schema.Boolean,
      /** The general "Members can use their own keys" plugin flag. */
      pluginOverridesAllowed: Schema.Boolean,
      /** The Orb opt-in (default off). */
      executionOverridesAllowed: Schema.Boolean,
    }),
  ),
  /**
   * Providers a new Thread can start on, for the requested project (or a
   * projectless Thread). One per provider; precedence picks its account.
   * Empty when the person has no provider: they connect one first.
   */
  resolved: Schema.Array(OrbResolvedProviderSchema),
});

export type OrbProviderListData = typeof OrbProviderListDataSchema.Type;

export const OrbProviderListResponseSchema = successResponse(
  OrbProviderListDataSchema,
);

export const OrbProviderListQuerySchema = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});

export const WorkspaceOrbProviderParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const OrbProviderParamsSchema = Schema.Struct({
  providerId: OrbProviderId,
});

export const SetOrbProviderConnectionRequestSchema = Schema.Struct({
  credentials: OrbProviderCredentials,
});

export type SetOrbProviderConnectionRequest =
  typeof SetOrbProviderConnectionRequestSchema.Type;

export const SetOrbProviderPolicyRequestSchema = Schema.Struct({
  allowPersonalKeysOnWorkspaceProjects: Schema.Boolean,
});

export const OrbProviderInvalidRequestResponseSchema = errorResponse(
  "INVALID_ORB_PROVIDER_REQUEST",
  "Orb provider request is invalid.",
);

/** The provider refused the credentials; `detail` says what to fix. */
export const OrbProviderCredentialsRejectedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("ORB_PROVIDER_CREDENTIALS_REJECTED"),
    message: Schema.Literal("The provider rejected these credentials."),
    requestId: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
});

export const OrbProviderForbiddenResponseSchema = errorResponse(
  "ORB_PROVIDER_SETTINGS_FORBIDDEN",
  "This Orb provider settings action is not permitted.",
);

export const OrbProviderUnavailableResponseSchema = errorResponse(
  "ORB_PROVIDER_SETTINGS_UNAVAILABLE",
  "Orb provider settings are temporarily unavailable.",
);

export const OrbProviderErrorResponseSchema = Schema.Union([
  OrbProviderInvalidRequestResponseSchema,
  OrbProviderCredentialsRejectedResponseSchema,
  OrbProviderForbiddenResponseSchema,
  OrbProviderUnavailableResponseSchema,
]);
