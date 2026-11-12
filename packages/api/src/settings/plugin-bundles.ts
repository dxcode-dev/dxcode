import {
  McpServerEndpoint,
  McpServerId,
  PluginBundleCode,
  PluginBundleManifest,
  PluginBundleSkipped,
  PluginBundleSource,
  PluginId,
  PluginIntegrity,
  SkillId,
  Timestamp,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** A skill a plugin bundle installed into the Skills store. */
export const PluginBundleSkillDataSchema = Schema.Struct({
  id: SkillId,
  name: Schema.String,
  enabled: Schema.Boolean,
});

/** An MCP server a plugin bundle installed into the MCP server store. */
export const PluginBundleMcpServerDataSchema = Schema.Struct({
  id: McpServerId,
  name: Schema.String,
  endpoint: McpServerEndpoint,
  /** Whether at least one of its tools is discovered and approved. */
  reviewed: Schema.Boolean,
});

/** A local MCP server of the bundle: dxd runs it in each Thread's Orb. */
export const PluginBundleLocalMcpServerDataSchema = Schema.Struct({
  name: Schema.String,
  /** Its command line, with `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` unexpanded. */
  command: Schema.String,
});

/**
 * A verified `plugin.sig`: the signer's key, and who that is as far as dx
 * can prove: the viewer's own Signing Keys key, the publisher domain the
 * plugin's name claims when it lists the key, or only the key.
 */
export const PluginSignatureDataSchema = Schema.Struct({
  fingerprint: Schema.String,
  publicKey: Schema.String,
  signer: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("you") }),
    Schema.Struct({
      kind: Schema.Literal("publisher"),
      domain: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("key") }),
  ]),
});

export type PluginSignatureData = typeof PluginSignatureDataSchema.Type;

export const PluginBundleDataSchema = Schema.Struct({
  id: PluginId,
  scope: Schema.Literals(["personal", "workspace"]),
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  version: Schema.optional(Schema.String),
  /** The plugin's icon as a `data:` URL, sanitized when it is an SVG. */
  icon: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  source: PluginBundleSource,
  integrity: PluginIntegrity,
  skills: Schema.Array(PluginBundleSkillDataSchema),
  mcpServers: Schema.Array(PluginBundleMcpServerDataSchema),
  /** dx's code layer and what it may reach, when the plugin has code. */
  code: Schema.optional(PluginBundleCode),
  localMcpServers: Schema.Array(PluginBundleLocalMcpServerDataSchema),
  skipped: Schema.Array(PluginBundleSkipped),
  /**
   * A personal plugin that a workspace of this person also installs: paused
   * while the workspace provides it, or running in place of the workspace's
   * copy when the workspace allows personal plugin overrides.
   */
  overlap: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["paused", "replacing"]),
      workspaceName: Schema.String,
    }),
  ),
  /** Whether an open share link shares this install. */
  shared: Schema.optional(Schema.Boolean),
  /** The active version's verified signature, when it is signed. */
  signature: Schema.optional(PluginSignatureDataSchema),
  installedAt: Timestamp,
  updatedAt: Timestamp,
});

export type PluginBundleData = typeof PluginBundleDataSchema.Type;

/**
 * A new share link. The token is shown once: dx keeps only its hash.
 * `url` opens the Plugins page, which reviews and installs the plugin.
 */
export const CreatePluginShareLinkResponseSchema = successResponse(
  Schema.Struct({
    linkId: Schema.String,
    token: Schema.String,
    url: Schema.String,
  }),
);

export const RevokePluginShareLinksResponseSchema = successResponse(
  Schema.Struct({ revoked: Schema.Number }),
);

export const PluginBundleChangeSchema = Schema.Literals([
  "added",
  "changed",
  "removed",
  "unchanged",
]);

/** One kind of grant an update adds to or drops from the reviewed version. */
export const PluginPermissionChangeSchema = Schema.Struct({
  permission: Schema.Literals([
    "code",
    "events",
    "network",
    "secrets",
    "tools",
    "ui",
    "ai",
    "threads",
    "models",
    "agents",
    "shell",
    "settings",
    "mcp",
    "commands",
  ]),
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
});

export type PluginPermissionChange = typeof PluginPermissionChangeSchema.Type;

/**
 * A plugin install or update dx proposed from a Thread, waiting for a person
 * who could install it themselves. Approving installs the pinned commit.
 */
export const PluginProposalDataSchema = Schema.Struct({
  id: Schema.String,
  change: Schema.Literals(["new", "update"]),
  name: Schema.String,
  /** The installed plugin an update replaces. */
  pluginId: Schema.optional(PluginId),
  source: PluginBundleSource,
  integrity: PluginIntegrity,
  manifest: PluginBundleManifest,
  /** An update only: what it changes, as the update review shows it. */
  permissions: Schema.optional(
    Schema.Struct({
      widens: Schema.Boolean,
      changes: Schema.Array(PluginPermissionChangeSchema),
    }),
  ),
  skills: Schema.optional(
    Schema.Array(
      Schema.Struct({ name: Schema.String, change: PluginBundleChangeSchema }),
    ),
  ),
  mcpServers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        endpoint: Schema.optional(Schema.String),
        command: Schema.optional(Schema.String),
        change: PluginBundleChangeSchema,
        credentialsCleared: Schema.Boolean,
      }),
    ),
  ),
  /** Why the agent proposed it, in its words. */
  note: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.optional(Schema.String),
  createdAt: Timestamp,
});

export type PluginProposalData = typeof PluginProposalDataSchema.Type;

export const PluginProposalParamsSchema = Schema.Struct({
  proposalId: Schema.String.check(Schema.isPattern(/^apr_[0-9a-f-]{36}$/)),
});

export const ApprovePluginProposalRequestSchema = Schema.Struct({
  /** The integrity the reviewer saw; approval fails if it changed. */
  reviewedIntegrity: PluginIntegrity,
});

export const DecidePluginProposalResponseSchema = successResponse(
  Schema.Struct({
    proposalId: Schema.String,
    status: Schema.Literals(["approved", "rejected"]),
  }),
);

export const ListPluginBundlesResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(PluginBundleDataSchema),
    canMutate: Schema.Boolean,
    /**
     * Workspace lists only: the "allow personal plugin overrides" policy,
     * which lets members run their own copy instead of the workspace's.
     */
    personalOverridesAllowed: Schema.optional(Schema.Boolean),
    /**
     * Workspace lists only: whether plugins a project's repository carries
     * in `.agents/plugins` load in its Threads.
     */
    repositoryPluginsAllowed: Schema.optional(Schema.Boolean),
    /** Pending agent proposals; only for people who could decide them. */
    proposals: Schema.optional(Schema.Array(PluginProposalDataSchema)),
  }),
);

/** Changes the workspace's plugin policies; an absent field stays as is. */
export const SetPluginBundlePolicyRequestSchema = Schema.Struct({
  allowPersonalOverrides: Schema.optional(Schema.Boolean),
  allowRepositoryPlugins: Schema.optional(Schema.Boolean),
});

export type SetPluginBundlePolicyRequest =
  typeof SetPluginBundlePolicyRequestSchema.Type;

export type PluginBundleListData =
  typeof ListPluginBundlesResponseSchema.Type.data;

export const PluginBundlePreviewDataSchema = Schema.Struct({
  manifest: PluginBundleManifest,
  source: PluginBundleSource,
  integrity: PluginIntegrity,
  /** Reasons the bundle cannot be installed in this scope. */
  conflicts: Schema.Array(Schema.String),
  /** Its verified signature; an invalid one is listed as a conflict. */
  signature: Schema.optional(PluginSignatureDataSchema),
});

export type PluginBundlePreviewData = typeof PluginBundlePreviewDataSchema.Type;

export const PreviewPluginBundleResponseSchema = successResponse(
  PluginBundlePreviewDataSchema,
);

/** A new version of an installed bundle and what installing it changes. */
export const PluginBundleUpdatePreviewDataSchema = Schema.Struct({
  ...PluginBundlePreviewDataSchema.fields,
  upToDate: Schema.Boolean,
  /**
   * What the new version changes in the grants reviewed at install. When it
   * widens them, updating needs `acceptPermissions`.
   */
  permissions: Schema.Struct({
    widens: Schema.Boolean,
    changes: Schema.Array(PluginPermissionChangeSchema),
  }),
  skills: Schema.Array(
    Schema.Struct({ name: Schema.String, change: PluginBundleChangeSchema }),
  ),
  mcpServers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      /** A remote server's URL. */
      endpoint: Schema.optional(Schema.String),
      /** A local server's command line. */
      command: Schema.optional(Schema.String),
      change: PluginBundleChangeSchema,
      /** The server moves to another origin, so its secrets are deleted. */
      credentialsCleared: Schema.Boolean,
    }),
  ),
});

export type PluginBundleUpdatePreviewData =
  typeof PluginBundleUpdatePreviewDataSchema.Type;

export const PreviewPluginBundleUpdateResponseSchema = successResponse(
  PluginBundleUpdatePreviewDataSchema,
);

/**
 * Installed plugins whose source has a newer version: only those dx could
 * check. A plugin missing from the list could not be checked.
 */
export const ListPluginBundleUpdatesResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({ pluginId: PluginId, available: Schema.Boolean }),
    ),
  }),
);

export type PluginBundleUpdatesData =
  typeof ListPluginBundleUpdatesResponseSchema.Type.data;

export const UpdatePluginBundleSourceResponseSchema = successResponse(
  PluginBundleDataSchema,
);

export const InstallPluginBundleResponseSchema = successResponse(
  PluginBundleDataSchema,
);

export const PluginBundleParamsSchema = Schema.Struct({ pluginId: PluginId });

export const UpdatePluginBundleRequestSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

export const UpdatePluginBundleResponseSchema = successResponse(
  PluginBundleDataSchema,
);

const PluginSettingValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(1_024)),
  Schema.Finite,
  Schema.Boolean,
]);

/** One install-time setting a plugin's code declares, with its value. */
export const PluginBundleSettingDataSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["string", "number", "boolean"]),
  required: Schema.Boolean,
  default: Schema.optional(PluginSettingValue),
  /** The value the install saved; absent when it uses the default. */
  value: Schema.optional(PluginSettingValue),
});

export type PluginBundleSettingData = typeof PluginBundleSettingDataSchema.Type;

export const PluginBundleSettingsResponseSchema = successResponse(
  Schema.Struct({ settings: Schema.Array(PluginBundleSettingDataSchema) }),
);

/** New values by key; null clears a value back to its default. */
export const UpdatePluginBundleSettingsRequestSchema = Schema.Struct({
  values: Schema.Record(Schema.String, Schema.NullOr(PluginSettingValue)),
});

export const RemovePluginBundleResponseSchema = successResponse(
  Schema.Struct({ removedPluginId: PluginId }),
);

/** The bundle or request was refused; `message` says why. */
export const PluginBundleRejectedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("PLUGIN_BUNDLE_REJECTED"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export const PluginBundleSourceUnavailableResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("PLUGIN_BUNDLE_SOURCE_UNAVAILABLE"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export const PluginBundlesForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const PluginBundleNotFoundResponseSchema = errorResponse(
  "PLUGIN_NOT_FOUND",
  "Plugin not found.",
);

export const PluginProposalDecidedResponseSchema = errorResponse(
  "PLUGIN_PROPOSAL_DECIDED",
  "This proposal was already decided.",
);

export const PluginBundleIntegrityConflictResponseSchema = errorResponse(
  "PLUGIN_INTEGRITY_CONFLICT",
  "The plugin changed since you reviewed it. Preview it again.",
);

export const PluginBundlesUnavailableResponseSchema = errorResponse(
  "PLUGINS_UNAVAILABLE",
  "Plugins are temporarily unavailable.",
);

export const PluginCatalogNotFoundResponseSchema = errorResponse(
  "PLUGIN_CATALOG_NOT_FOUND",
  "Catalog not found.",
);

export const PluginBundlesErrorResponseSchema = Schema.Union([
  PluginBundleRejectedResponseSchema,
  PluginBundleSourceUnavailableResponseSchema,
  PluginBundlesForbiddenResponseSchema,
  PluginBundleNotFoundResponseSchema,
  PluginBundleIntegrityConflictResponseSchema,
  PluginBundlesUnavailableResponseSchema,
  PluginCatalogNotFoundResponseSchema,
]);
