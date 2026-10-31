import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { McpServerEndpoint, McpServerName } from "./mcp-server.js";
import {
  PluginId,
  PluginIntegrity,
  PluginName,
  PluginTarget,
  PluginVersion,
} from "./plugin.js";
import type {
  PluginIntegrityConflict,
  PluginNotFound,
} from "./plugin-repository.js";
import { MAX_SKILLS_PER_SCOPE, SkillDescription, SkillName } from "./skill.js";

/**
 * A plugin bundle in Claude Code's format: its skills and remote MCP servers
 * imported together as one plugin row. They live in the Skills and MCP server
 * stores, linked back by plugin ID. Commands are Claude Code only and are not
 * imported.
 */

export const MAX_PLUGIN_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_ENTRIES = 20_000;
export const MAX_PLUGIN_BUNDLE_MCP_SERVERS = 10;
export const MAX_PLUGIN_BUNDLE_SKIPPED = 100;
/** The bytes of text a bundle may keep across its skills. */
export const MAX_PLUGIN_BUNDLE_TEXT_BYTES = 2 * 1024 * 1024;

export const PluginBundleMcpHeader = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/),
  ),
  value: Schema.String.check(Schema.isMaxLength(4_096)),
});

export const PluginBundleMcpServer = Schema.Struct({
  name: McpServerName,
  endpoint: McpServerEndpoint,
  /** `bearer` when the bundle reads an Authorization token from a variable. */
  authType: Schema.Literals(["none", "bearer"]),
  headers: Schema.Array(PluginBundleMcpHeader).check(Schema.isMaxLength(16)),
});

export type PluginBundleMcpServer = typeof PluginBundleMcpServer.Type;

export const PluginBundleSkipped = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export type PluginBundleSkipped = typeof PluginBundleSkipped.Type;

export const PluginBundleManifest = Schema.Struct({
  format: Schema.Literal("claude-code"),
  name: PluginName,
  displayName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(96),
  ),
  description: Schema.String.check(Schema.isMaxLength(1_024)),
  /** The version the bundle declares, when it declares one. */
  version: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
  skills: Schema.Array(
    Schema.Struct({ name: SkillName, description: SkillDescription }),
  ).check(Schema.isMaxLength(MAX_SKILLS_PER_SCOPE)),
  mcpServers: Schema.Array(PluginBundleMcpServer).check(
    Schema.isMaxLength(MAX_PLUGIN_BUNDLE_MCP_SERVERS),
  ),
  skipped: Schema.Array(PluginBundleSkipped).check(
    Schema.isMaxLength(MAX_PLUGIN_BUNDLE_SKIPPED),
  ),
});

export type PluginBundleManifest = typeof PluginBundleManifest.Type;

export const PluginBundleGitHubRepository = Schema.String.check(
  Schema.isMaxLength(140),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/),
);

export const PluginBundleSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("zip"),
    label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    type: Schema.Literal("github"),
    repository: PluginBundleGitHubRepository,
    /** The branch, tag, or commit asked for; `HEAD` for the default branch. */
    ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
    /** The plugin's folder in the repository; empty for its root. */
    path: Schema.String.check(Schema.isMaxLength(256)),
    commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  }),
]);

export type PluginBundleSource = typeof PluginBundleSource.Type;

export const StoredPluginBundle = Schema.Struct({
  id: PluginId,
  target: PluginTarget,
  name: PluginName,
  enabled: Schema.Boolean,
  version: PluginVersion,
  manifest: PluginBundleManifest,
  source: PluginBundleSource,
  integrity: PluginIntegrity,
  installedAt: Timestamp,
  installedByUserId: UserId,
  updatedAt: Timestamp,
});

export type StoredPluginBundle = typeof StoredPluginBundle.Type;

type BundleRepositoryFailure = PersistenceUnavailable | Schema.SchemaError;

export interface PluginBundleRepositoryShape {
  readonly list: (
    target: PluginTarget,
  ) => Effect.Effect<
    ReadonlyArray<StoredPluginBundle>,
    BundleRepositoryFailure
  >;
  readonly find: (
    target: PluginTarget,
    id: PluginId,
  ) => Effect.Effect<
    StoredPluginBundle,
    BundleRepositoryFailure | PluginNotFound
  >;
  /** Names every plugin row in the target, code plugins included. */
  readonly names: (
    target: PluginTarget,
  ) => Effect.Effect<ReadonlyArray<string>, BundleRepositoryFailure>;
  readonly insert: (
    bundle: StoredPluginBundle,
  ) => Effect.Effect<void, BundleRepositoryFailure | PluginIntegrityConflict>;
  /**
   * Records a new version of an installed bundle and makes it active. A
   * version with the active one's integrity is an integrity conflict.
   */
  readonly insertVersion: (
    bundle: StoredPluginBundle,
  ) => Effect.Effect<
    void,
    BundleRepositoryFailure | PluginNotFound | PluginIntegrityConflict
  >;
  readonly setEnabled: (
    target: PluginTarget,
    id: PluginId,
    enabled: boolean,
    updatedAt: StoredPluginBundle["updatedAt"],
  ) => Effect.Effect<void, BundleRepositoryFailure | PluginNotFound>;
  readonly remove: (
    target: PluginTarget,
    id: PluginId,
    removedAt: StoredPluginBundle["updatedAt"],
  ) => Effect.Effect<void, BundleRepositoryFailure | PluginNotFound>;
}

export class PluginBundleRepository extends Context.Service<
  PluginBundleRepository,
  PluginBundleRepositoryShape
>()("@dx/domain/settings/PluginBundleRepository") {}
