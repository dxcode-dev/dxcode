import { Effect, Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { EnvironmentVariableConfigReference } from "./environment-variable.js";
import { McpServerId } from "./mcp-server.js";
import { WorkspaceId } from "./workspace.js";

export const MAX_PLUGINS_PER_SCOPE = 20;
export const MAX_PLUGIN_FILES = 32;
export const MAX_PLUGIN_FILE_BYTES = 65_536;
export const MAX_PLUGIN_TOTAL_BYTES = 524_288;
export const MAX_PLUGIN_MANIFEST_BYTES = 32_768;
export const MAX_PLUGIN_TOOLS = 20;
export const MAX_PLUGIN_COMMANDS = 20;
export const MAX_PLUGIN_NETWORK_DESTINATIONS = 20;
export const MAX_PLUGIN_SECRET_REFERENCES = 20;
export const MAX_PLUGIN_MCP_REFERENCES = 10;
export const MAX_PLUGIN_TRIGGERS = 20;

export const PluginId = Schema.String.check(
  Schema.isPattern(
    /^plg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/PluginId"));

export type PluginId = typeof PluginId.Type;

export const PluginName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("@dx/PluginName"));

export type PluginName = typeof PluginName.Type;

export const PluginVersion = Schema.String.check(
  Schema.isMinLength(5),
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  ),
).pipe(Schema.brand("@dx/PluginVersion"));

export type PluginVersion = typeof PluginVersion.Type;

export const PluginIntegrity = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("@dx/PluginIntegrity"));

export type PluginIntegrity = typeof PluginIntegrity.Type;

export const PluginCapabilityName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(48),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
).pipe(Schema.brand("@dx/PluginCapabilityName"));

export type PluginCapabilityName = typeof PluginCapabilityName.Type;

export const PluginToolName = PluginCapabilityName.pipe(
  Schema.brand("@dx/PluginToolName"),
);

export type PluginToolName = typeof PluginToolName.Type;

export const PluginCommandName = PluginCapabilityName.pipe(
  Schema.brand("@dx/PluginCommandName"),
);

export type PluginCommandName = typeof PluginCommandName.Type;

export const PluginSecretName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/),
).pipe(Schema.brand("@dx/PluginSecretName"));

export type PluginSecretName = typeof PluginSecretName.Type;

export const PluginLifecycleEvent = Schema.Literals([
  "agent-start",
  "agent-finish",
]);

export type PluginLifecycleEvent = typeof PluginLifecycleEvent.Type;

export const PluginFilesystemPermission = Schema.Literal("project-read");

export type PluginFilesystemPermission = typeof PluginFilesystemPermission.Type;

export const PluginAgentCapability = Schema.Literal("thread-metadata");

export type PluginAgentCapability = typeof PluginAgentCapability.Type;

export const PluginNetworkDestination = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(253),
  Schema.makeFilter((value) => {
    if (value === "localhost" || value.includes(":") || value.includes("/")) {
      return false;
    }
    const candidate = value.startsWith("*.") ? value.slice(2) : value;
    if (
      candidate === "" ||
      candidate.endsWith(".") ||
      candidate.startsWith(".") ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)
    ) {
      return false;
    }
    return candidate
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
      );
  }),
).pipe(Schema.brand("@dx/PluginNetworkDestination"));

export type PluginNetworkDestination = typeof PluginNetworkDestination.Type;

const unique = <A>(values: ReadonlyArray<A>) =>
  new Set(values).size === values.length;

export const PluginToolDeclaration = Schema.Struct({
  name: PluginToolName,
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
  ),
});

export type PluginToolDeclaration = typeof PluginToolDeclaration.Type;

export const PluginCommandDeclaration = Schema.Struct({
  name: PluginCommandName,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(96)),
  description: Schema.String.check(Schema.isMaxLength(512)),
  tool: PluginToolName,
});

export type PluginCommandDeclaration = typeof PluginCommandDeclaration.Type;

export const PluginLifecycleDeclaration = Schema.Struct({
  event: PluginLifecycleEvent,
});

export const PluginTriggerEvent = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(96),
  Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
).pipe(Schema.brand("@dx/PluginTriggerEvent"));

export type PluginTriggerEvent = typeof PluginTriggerEvent.Type;

export const PluginTriggerDeclaration = Schema.Struct({
  name: PluginCapabilityName,
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
  source: Schema.Literal("webhook"),
  event: PluginTriggerEvent,
  action: PluginCapabilityName,
  idempotent: Schema.Boolean,
});

export type PluginTriggerDeclaration = typeof PluginTriggerDeclaration.Type;

export const PluginUiSurfaceDeclaration = Schema.Struct({
  id: PluginCapabilityName,
  location: Schema.Literal("settings-card"),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(96)),
  description: Schema.String.check(Schema.isMaxLength(512)),
});

export type PluginUiSurfaceDeclaration = typeof PluginUiSurfaceDeclaration.Type;

export const PluginRequestedPermissions = Schema.Struct({
  tools: Schema.Array(PluginToolName).check(
    Schema.isMaxLength(MAX_PLUGIN_TOOLS),
    Schema.makeFilter(unique),
  ),
  commands: Schema.Array(PluginCommandName).check(
    Schema.isMaxLength(MAX_PLUGIN_COMMANDS),
    Schema.makeFilter(unique),
  ),
  lifecycle: Schema.Array(PluginLifecycleEvent).check(
    Schema.isMaxLength(2),
    Schema.makeFilter(unique),
  ),
  uiSurfaces: Schema.Array(PluginCapabilityName).check(
    Schema.isMaxLength(10),
    Schema.makeFilter(unique),
  ),
  networkDestinations: Schema.Array(PluginNetworkDestination).check(
    Schema.isMaxLength(MAX_PLUGIN_NETWORK_DESTINATIONS),
    Schema.makeFilter(unique),
  ),
  secretNames: Schema.Array(PluginSecretName).check(
    Schema.isMaxLength(MAX_PLUGIN_SECRET_REFERENCES),
    Schema.makeFilter(unique),
  ),
  filesystem: Schema.Array(PluginFilesystemPermission).check(
    Schema.isMaxLength(1),
    Schema.makeFilter(unique),
  ),
  mcpServerIds: Schema.Array(McpServerId).check(
    Schema.isMaxLength(MAX_PLUGIN_MCP_REFERENCES),
    Schema.makeFilter(unique),
  ),
  agentCapabilities: Schema.Array(PluginAgentCapability).check(
    Schema.isMaxLength(1),
    Schema.makeFilter(unique),
  ),
  triggers: Schema.Array(PluginCapabilityName)
    .check(Schema.isMaxLength(MAX_PLUGIN_TRIGGERS), Schema.makeFilter(unique))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

export type PluginRequestedPermissions = typeof PluginRequestedPermissions.Type;

export const PluginSecretGrant = Schema.Struct({
  name: PluginSecretName,
  reference: EnvironmentVariableConfigReference,
});

export type PluginSecretGrant = typeof PluginSecretGrant.Type;

export const PluginGrantedPermissions = Schema.Struct({
  tools: Schema.Array(PluginToolName).check(
    Schema.isMaxLength(MAX_PLUGIN_TOOLS),
    Schema.makeFilter(unique),
  ),
  commands: Schema.Array(PluginCommandName).check(
    Schema.isMaxLength(MAX_PLUGIN_COMMANDS),
    Schema.makeFilter(unique),
  ),
  lifecycle: Schema.Array(PluginLifecycleEvent).check(
    Schema.isMaxLength(2),
    Schema.makeFilter(unique),
  ),
  uiSurfaces: Schema.Array(PluginCapabilityName).check(
    Schema.isMaxLength(10),
    Schema.makeFilter(unique),
  ),
  networkDestinations: Schema.Array(PluginNetworkDestination).check(
    Schema.isMaxLength(MAX_PLUGIN_NETWORK_DESTINATIONS),
    Schema.makeFilter(unique),
  ),
  secretReferences: Schema.Array(PluginSecretGrant).check(
    Schema.isMaxLength(MAX_PLUGIN_SECRET_REFERENCES),
    Schema.makeFilter((values) => unique(values.map(({ name }) => name))),
  ),
  filesystem: Schema.Array(PluginFilesystemPermission).check(
    Schema.isMaxLength(1),
    Schema.makeFilter(unique),
  ),
  mcpServerIds: Schema.Array(McpServerId).check(
    Schema.isMaxLength(MAX_PLUGIN_MCP_REFERENCES),
    Schema.makeFilter(unique),
  ),
  agentCapabilities: Schema.Array(PluginAgentCapability).check(
    Schema.isMaxLength(1),
    Schema.makeFilter(unique),
  ),
  triggers: Schema.Array(PluginCapabilityName)
    .check(Schema.isMaxLength(MAX_PLUGIN_TRIGGERS), Schema.makeFilter(unique))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

export type PluginGrantedPermissions = typeof PluginGrantedPermissions.Type;

export const PluginManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: PluginName,
  displayName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(96),
  ),
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_024),
  ),
  version: PluginVersion,
  entrypoint: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  tools: Schema.Array(PluginToolDeclaration).check(
    Schema.isMaxLength(MAX_PLUGIN_TOOLS),
    Schema.makeFilter((values) => unique(values.map(({ name }) => name))),
  ),
  commands: Schema.Array(PluginCommandDeclaration).check(
    Schema.isMaxLength(MAX_PLUGIN_COMMANDS),
    Schema.makeFilter((values) => unique(values.map(({ name }) => name))),
  ),
  lifecycle: Schema.Array(PluginLifecycleDeclaration).check(
    Schema.isMaxLength(2),
    Schema.makeFilter((values) => unique(values.map(({ event }) => event))),
  ),
  triggers: Schema.Array(PluginTriggerDeclaration)
    .check(
      Schema.isMaxLength(MAX_PLUGIN_TRIGGERS),
      Schema.makeFilter((values) => unique(values.map(({ name }) => name))),
    )
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  uiSurfaces: Schema.Array(PluginUiSurfaceDeclaration).check(
    Schema.isMaxLength(10),
    Schema.makeFilter((values) => unique(values.map(({ id }) => id))),
  ),
  permissions: PluginRequestedPermissions,
});

export type PluginManifest = typeof PluginManifest.Type;

export const PluginBrowserFileSource = Schema.Struct({
  type: Schema.Literal("browser-files"),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

export const PluginSource = PluginBrowserFileSource;

export type PluginSource = typeof PluginSource.Type;

export const PersonalPluginTarget = Schema.Struct({
  scope: Schema.Literal("personal"),
  id: UserId,
});

export const WorkspacePluginTarget = Schema.Struct({
  scope: Schema.Literal("workspace"),
  id: WorkspaceId,
});

export const PluginTarget = Schema.Union([
  PersonalPluginTarget,
  WorkspacePluginTarget,
]);

export type PluginTarget = typeof PluginTarget.Type;

export const PluginFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  mediaType: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  content: Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_FILE_BYTES)),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_PLUGIN_FILE_BYTES }),
  ),
  integrity: PluginIntegrity,
});

export type PluginFile = typeof PluginFile.Type;

export const PluginHealthStatus = Schema.Literals([
  "unchecked",
  "healthy",
  "unhealthy",
]);

export type PluginHealthStatus = typeof PluginHealthStatus.Type;

export const StoredPluginVersion = Schema.Struct({
  pluginId: PluginId,
  version: PluginVersion,
  manifest: PluginManifest,
  files: Schema.Array(PluginFile).check(Schema.isMaxLength(MAX_PLUGIN_FILES)),
  source: PluginSource,
  integrity: PluginIntegrity,
  grants: PluginGrantedPermissions,
  trusted: Schema.Literal(true),
  trustedAt: Timestamp,
  trustedByUserId: UserId,
});

export type StoredPluginVersion = typeof StoredPluginVersion.Type;

export const StoredPlugin = Schema.Struct({
  id: PluginId,
  target: PluginTarget,
  name: PluginName,
  enabled: Schema.Boolean,
  activeVersion: PluginVersion,
  healthStatus: PluginHealthStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  removedAt: Schema.optional(Timestamp),
});

export type StoredPlugin = typeof StoredPlugin.Type;

export const PluginWithVersion = Schema.Struct({
  plugin: StoredPlugin,
  active: StoredPluginVersion,
  versions: Schema.Array(PluginVersion).check(Schema.isMinLength(1)),
});

export type PluginWithVersion = typeof PluginWithVersion.Type;

export const ResolvedPluginSnapshot = Schema.Struct({
  id: PluginId,
  version: PluginVersion,
  name: PluginName,
  scope: Schema.Literals(["personal", "workspace"]),
  integrity: PluginIntegrity,
});

export type ResolvedPluginSnapshot = typeof ResolvedPluginSnapshot.Type;

export const ResolvedPluginSnapshots = Schema.Array(
  ResolvedPluginSnapshot,
).check(Schema.isMaxLength(MAX_PLUGINS_PER_SCOPE * 2));

export const PluginImportFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Schema.Literals(["file", "symlink"]),
  mediaType: Schema.String.check(Schema.isMaxLength(128)),
  encoding: Schema.Literal("utf-8"),
  content: Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_FILE_BYTES)),
});

export type PluginImportFile = typeof PluginImportFile.Type;

export const PluginImportBundle = Schema.Struct({
  source: PluginSource,
  files: Schema.Array(PluginImportFile).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(MAX_PLUGIN_FILES),
  ),
});

export type PluginImportBundle = typeof PluginImportBundle.Type;

export const pluginFlueToolName = (
  pluginId: PluginId,
  toolName: PluginToolName,
): string => `dx_${pluginId.replace(/[^A-Za-z0-9_-]/g, "_")}__${toolName}`;

export const normalizePluginName = (value: string): string =>
  value.trim().toLowerCase();

export const pluginPermissionsEmpty = (): PluginGrantedPermissions => ({
  tools: [],
  commands: [],
  lifecycle: [],
  uiSurfaces: [],
  networkDestinations: [],
  secretReferences: [],
  filesystem: [],
  mcpServerIds: [],
  agentCapabilities: [],
  triggers: [],
});
