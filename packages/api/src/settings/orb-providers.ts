import {
  ExecutionPauseResumePreserves,
  PluginCredential,
  PluginScope,
  ProjectId,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** Orb (Execution) providers a deployment can list. */
export const OrbProviderId = Schema.Literals(["e2b", "cloudflare", "local"]);

export type OrbProviderId = typeof OrbProviderId.Type;

/**
 * The Orb template in a key's own provider account: `building` until
 * every size is ready, `ready`, or `failed` (save the key again to retry).
 */
export const OrbTemplateStatus = Schema.Literals([
  "building",
  "ready",
  "failed",
]);

export type OrbTemplateStatus = typeof OrbTemplateStatus.Type;

/** A person's or workspace's own key; the key itself is never returned. */
export const OrbProviderKeyDataSchema = Schema.Struct({
  configuredAt: Schema.String,
  /** The provider account (E2B team) the key belongs to, once known. */
  account: Schema.NullOr(Schema.String),
  /** Null in the local runtime, which ignores the key. */
  template: Schema.NullOr(
    Schema.Struct({
      status: OrbTemplateStatus,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});

export type OrbProviderKeyData = typeof OrbProviderKeyDataSchema.Type;

export const OrbProviderDataSchema = Schema.Struct({
  id: OrbProviderId,
  displayName: Schema.String,
  /** Null for providers a person cannot key (deployment scope only). */
  credentialLabel: Schema.NullOr(Schema.String),
  pauseResume: Schema.NullOr(ExecutionPauseResumePreserves),
  /** The deployment provides this provider with its own account. */
  deployment: Schema.Boolean,
  /** This scope's own key. */
  key: Schema.NullOr(OrbProviderKeyDataSchema),
  /** The workspace's key, shown to a member on the personal page. */
  workspaceKey: Schema.NullOr(OrbProviderKeyDataSchema),
});

export type OrbProviderData = typeof OrbProviderDataSchema.Type;

/** One provider a Thread can start on, with whose key pays for it. */
export const OrbResolvedProviderSchema = Schema.Struct({
  providerId: OrbProviderId,
  scope: PluginScope,
  account: Schema.NullOr(Schema.String),
  status: OrbTemplateStatus,
});

export type OrbResolvedProvider = typeof OrbResolvedProviderSchema.Type;

export const OrbProviderListDataSchema = Schema.Struct({
  scope: Schema.Literals(["personal", "workspace"]),
  canUpdate: Schema.Boolean,
  /** The local runtime ignores personal and workspace keys. */
  localRuntime: Schema.Boolean,
  providers: Schema.Array(OrbProviderDataSchema),
  /**
   * Whether members' own keys apply on workspace projects: both the
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
   * projectless Thread). One per provider; precedence picks its key.
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

export const SetOrbProviderKeyRequestSchema = Schema.Struct({
  credential: PluginCredential,
});

export type SetOrbProviderKeyRequest =
  typeof SetOrbProviderKeyRequestSchema.Type;

export const SetOrbProviderPolicyRequestSchema = Schema.Struct({
  allowPersonalKeysOnWorkspaceProjects: Schema.Boolean,
});

export const OrbProviderInvalidRequestResponseSchema = errorResponse(
  "INVALID_ORB_PROVIDER_REQUEST",
  "Orb provider request is invalid.",
);

export const OrbProviderKeyRejectedResponseSchema = errorResponse(
  "ORB_PROVIDER_KEY_REJECTED",
  "The provider rejected this key.",
);

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
  OrbProviderKeyRejectedResponseSchema,
  OrbProviderForbiddenResponseSchema,
  OrbProviderUnavailableResponseSchema,
]);
