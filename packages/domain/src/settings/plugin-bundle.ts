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
import { PluginCatalogReference } from "./plugin-catalog-id.js";
import type {
  PluginIntegrityConflict,
  PluginNotFound,
} from "./plugin-repository.js";
import { MAX_SKILLS_PER_SCOPE, SkillDescription, SkillName } from "./skill.js";

/**
 * A plugin bundle in the Agent Plugins format (agent-plugins.org) or Claude
 * Code's format: its skills and MCP servers (remote, or local ones dxd runs
 * in the Orb) imported together as one
 * plugin row. They live in the Skills and MCP server
 * stores, linked back by plugin ID. Commands are Claude Code only and are not
 * imported.
 */

export const MAX_PLUGIN_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_ENTRIES = 20_000;
export const MAX_PLUGIN_BUNDLE_MCP_SERVERS = 10;
export const MAX_PLUGIN_BUNDLE_SKIPPED = 100;
/** The bytes of text a bundle may keep across its skills. */
export const MAX_PLUGIN_BUNDLE_TEXT_BYTES = 2 * 1024 * 1024;

/** The largest icon a bundle may carry, before base64. */
export const MAX_PLUGIN_ICON_BYTES = 64 * 1024;

/**
 * The plugin's icon, read from `assets/icon.png` or `assets/icon.svg`. A PNG
 * is kept as sent; an SVG is kept only after sanitizing.
 */
export const PluginBundleIcon = Schema.Struct({
  mediaType: Schema.Literals(["image/png", "image/svg+xml"]),
  /** The file's bytes in base64. */
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Math.ceil(MAX_PLUGIN_ICON_BYTES / 3) * 4),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
});

export type PluginBundleIcon = typeof PluginBundleIcon.Type;

export const PluginBundleMcpHeader = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/),
  ),
  value: Schema.String.check(Schema.isMaxLength(4_096)),
});

/** A remote MCP server: dx connects to it over streamable HTTP. */
export const PluginBundleRemoteMcpServer = Schema.Struct({
  name: McpServerName,
  endpoint: McpServerEndpoint,
  /** `bearer` when the bundle reads an Authorization token from a variable. */
  authType: Schema.Literals(["none", "bearer"]),
  headers: Schema.Array(PluginBundleMcpHeader).check(Schema.isMaxLength(16)),
});

export type PluginBundleRemoteMcpServer =
  typeof PluginBundleRemoteMcpServer.Type;

export const MAX_PLUGIN_STDIO_ARGS = 64;
export const MAX_PLUGIN_STDIO_ENV = 32;
export const MAX_PLUGIN_STDIO_VALUE_LENGTH = 4_096;

/**
 * A local MCP server (Agent Plugins §7.2.1 `stdio`): dxd starts it inside the
 * Thread's Orb from the plugin's own files. `command` is one token, a bare
 * executable name or a `./` path in the plugin. `args`, `env` values, and
 * `cwd` may hold `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, which dxd expands.
 */
export const PluginBundleStdioMcpServer = Schema.Struct({
  transport: Schema.Literal("stdio"),
  name: McpServerName,
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  args: Schema.Array(
    Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_STDIO_VALUE_LENGTH)),
  ).check(Schema.isMaxLength(MAX_PLUGIN_STDIO_ARGS)),
  env: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(
        Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      ),
      value: Schema.String.check(
        Schema.isMaxLength(MAX_PLUGIN_STDIO_VALUE_LENGTH),
      ),
    }),
  ).check(Schema.isMaxLength(MAX_PLUGIN_STDIO_ENV)),
  /** The working directory; the plugin root when absent. */
  cwd: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});

export type PluginBundleStdioMcpServer = typeof PluginBundleStdioMcpServer.Type;

export const PluginBundleMcpServer = Schema.Union([
  PluginBundleRemoteMcpServer,
  PluginBundleStdioMcpServer,
]);

export type PluginBundleMcpServer = typeof PluginBundleMcpServer.Type;

export const isStdioMcpServer = (
  server: PluginBundleMcpServer,
): server is PluginBundleStdioMcpServer =>
  "transport" in server && server.transport === "stdio";

/** The most bytes and files a plugin package (its folder, for the Orb) holds. */
export const MAX_PLUGIN_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_FILES = 5_000;

/**
 * The plugin's own files, kept so dxd can lay them out as `PLUGIN_ROOT` in
 * the Orb. Only bundles with a local MCP server keep them. `sha256` is the
 * digest of the stored package bytes and is part of the bundle's integrity.
 */
export const PluginBundlePackage = Schema.Struct({
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  size: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_PLUGIN_PACKAGE_BYTES }),
  ),
  files: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_PLUGIN_PACKAGE_FILES }),
  ),
});

export type PluginBundlePackage = typeof PluginBundlePackage.Type;

export const PluginBundleSkipped = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export type PluginBundleSkipped = typeof PluginBundleSkipped.Type;

/** dx's code layer: the events a plugin's code may handle. */
export const PLUGIN_CODE_EVENTS = [
  "session.start",
  "agent.start",
  "agent.end",
  "tool.call",
  "tool.result",
  "trigger.received",
  "changes.prompt",
] as const;

export const PluginCodeEvent = Schema.Literals(PLUGIN_CODE_EVENTS);

/**
 * dx's own UI a plugin's code may show in a Thread: `prompt` asks with
 * `ctx.ui.confirm`, `input`, and `select` above the composer; `notify`
 * shows a toast; `quick-action` adds buttons above the composer; `pane`
 * shows the plugin's own sandboxed views as Thread panes.
 */
export const PLUGIN_CODE_UI_GRANTS = [
  "prompt",
  "notify",
  "quick-action",
  "pane",
] as const;

export const PluginCodeUiGrant = Schema.Literals(PLUGIN_CODE_UI_GRANTS);

export type PluginCodeUiGrant = typeof PluginCodeUiGrant.Type;

/**
 * What a plugin's code may do with Threads: `create` (webhook triggers
 * only), `read`, and `post`.
 */
export const PLUGIN_CODE_THREAD_GRANTS = ["create", "read", "post"] as const;

export const PluginCodeThreadGrant = Schema.Literals(PLUGIN_CODE_THREAD_GRANTS);

export type PluginCodeThreadGrant = typeof PluginCodeThreadGrant.Type;

export type PluginCodeEvent = typeof PluginCodeEvent.Type;

/** The JavaScript modules a plugin's code may carry, and their bytes. */
export const MAX_PLUGIN_CODE_MODULES = 16;
export const MAX_PLUGIN_CODE_MODULE_BYTES = 65_536;
export const MAX_PLUGIN_CODE_TOTAL_BYTES = 512 * 1024;

const PluginCodeHost = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
  ),
);

const PluginCodeName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
);

/** At most this many models a plugin's code may choose. */
export const MAX_PLUGIN_CODE_MODELS = 16;
/** At most this many agent modes a plugin declares. */
export const MAX_PLUGIN_AGENT_MODES = 8;

/** A dx mode, or a `provider/model` ID as model routing names models. */
export const PluginCodeModel = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^(?:low|medium|high|ultra|[a-z0-9][a-z0-9._-]*\/[^\s]+)$/),
);

export type PluginCodeModel = typeof PluginCodeModel.Type;

/**
 * An agent mode a plugin declares in its manifest, so dx can list it, and
 * show it before install, without running the code. The code registers the
 * agent itself with `dx.registerAgentMode({ key, agent })`.
 */
export const PluginAgentMode = Schema.Struct({
  /** 1 to 24 lowercase letters, digits, and hyphens, starting with a letter. */
  key: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,23}$/)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  /** A hex RGB color such as `#7c3aed`. */
  color: Schema.optional(
    Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  ),
});

export type PluginAgentMode = typeof PluginAgentMode.Type;

/**
 * What a plugin's code may reach, declared under `extensions["dev.dxcode"]`
 * and shown before install. A capability not listed has no object in the
 * plugin's context.
 */
export const PluginCodePermissions = Schema.Struct({
  events: Schema.Array(PluginCodeEvent).check(Schema.isMaxLength(16)),
  /** Hosts `ctx.fetch` may reach; `*.example.com` covers subdomains. */
  network: Schema.Array(PluginCodeHost).check(Schema.isMaxLength(32)),
  /** Secret names from Secrets & Env Vars, in the install's scope. */
  secrets: Schema.Array(PluginCodeName).check(Schema.isMaxLength(32)),
  /** dx tools `ctx.tools.call` may call. */
  tools: Schema.Array(PluginCodeName).check(Schema.isMaxLength(64)),
  /** `ctx.ai`: model calls on the Thread's model route. */
  ai: Schema.Boolean,
  /** dx UI in the Thread; absent in versions stored before it existed. */
  ui: Schema.optional(
    Schema.Array(PluginCodeUiGrant).check(Schema.isMaxLength(8)),
  ),
  /**
   * Threads the code may reach as the install's caller: `create` starts
   * Threads from a webhook trigger, `read` reads Threads' messages and
   * details, `post` posts messages and notes into them. `true`, as versions
   * stored before `read` and `post` existed say, is `["create"]`.
   */
  threads: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Array(PluginCodeThreadGrant).check(Schema.isMaxLength(3)),
    ]),
  ),
  /**
   * Models the code may choose for its own model calls and agents:
   * `provider/model` IDs, or dx modes (`low`, `medium`, `high`, `ultra`).
   * Absent or empty: only the Thread's own model route.
   */
  models: Schema.optional(
    Schema.Array(PluginCodeModel).check(
      Schema.isMaxLength(MAX_PLUGIN_CODE_MODELS),
    ),
  ),
  /** `dx.createAgent(...).run` and agent modes: its agents run as Threads. */
  agents: Schema.optional(Schema.Boolean),
  /**
   * `ctx.$` and `ctx.exec`: shell commands in the Thread's Orb, in its
   * checkout, as the Thread's own commands run.
   */
  shell: Schema.optional(Schema.Boolean),
});

export type PluginCodePermissions = typeof PluginCodePermissions.Type;

/** The Thread grants a manifest's `permissions.threads` gives, in order. */
export const pluginThreadGrants = (
  threads: PluginCodePermissions["threads"],
): ReadonlyArray<PluginCodeThreadGrant> =>
  threads === true
    ? ["create"]
    : threads === undefined || threads === false
      ? []
      : PLUGIN_CODE_THREAD_GRANTS.filter((grant) => threads.includes(grant));

export const PluginCodeSetting = Schema.Struct({
  key: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  ),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(96)),
  type: Schema.Literals(["string", "number", "boolean"]),
  required: Schema.Boolean,
  default: Schema.optional(
    Schema.Union([
      Schema.String.check(Schema.isMaxLength(1_024)),
      Schema.Finite,
      Schema.Boolean,
    ]),
  ),
});

export type PluginCodeSetting = typeof PluginCodeSetting.Type;

/**
 * A plugin's code layer: a JavaScript entry module under `dev.dxcode/` that
 * dx runs in an isolated Cloudflare Dynamic Worker. `modules` lists every
 * module stored with the version, entry first.
 */
export const PluginBundleCode = Schema.Struct({
  apiVersion: Schema.Literal(1),
  host: Schema.Literal("worker"),
  entry: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  modules: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      bytes: Schema.Int.check(
        Schema.isBetween({ minimum: 0, maximum: MAX_PLUGIN_CODE_MODULE_BYTES }),
      ),
      integrity: PluginIntegrity,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PLUGIN_CODE_MODULES)),
  permissions: PluginCodePermissions,
  settings: Schema.Array(PluginCodeSetting).check(Schema.isMaxLength(32)),
  /** Agent modes it declares; each needs `permissions.agents`. */
  agentModes: Schema.optional(
    Schema.Array(PluginAgentMode).check(
      Schema.isMaxLength(MAX_PLUGIN_AGENT_MODES),
    ),
  ),
});

export type PluginBundleCode = typeof PluginBundleCode.Type;

export const PluginBundleManifest = Schema.Struct({
  format: Schema.Literals(["claude-code", "agent-plugins"]),
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
  /** dx's code layer, from `extensions["dev.dxcode"]`, when it has one. */
  code: Schema.optional(PluginBundleCode),
  skipped: Schema.Array(PluginBundleSkipped).check(
    Schema.isMaxLength(MAX_PLUGIN_BUNDLE_SKIPPED),
  ),
  icon: Schema.optional(PluginBundleIcon),
  /** Present when a local MCP server needs the plugin's files in the Orb. */
  package: Schema.optional(PluginBundlePackage),
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
    /**
     * The catalog it was installed from, only when the catalog's publisher
     * proved the domain in the plugin's name. Shown as `name@catalog`.
     */
    catalog: Schema.optional(PluginCatalogReference),
  }),
  /** Another install's share link; updates follow that install. */
  Schema.Struct({
    type: Schema.Literal("share"),
    linkId: Schema.String.check(Schema.isPattern(/^psl_[0-9a-f-]{36}$/)),
    label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    /**
     * The shared install's version this copy read; a different active
     * version there means an update is available.
     */
    sharedVersion: Schema.optional(
      Schema.String.check(Schema.isMinLength(5), Schema.isMaxLength(64)),
    ),
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

/** A code module's text, stored immutably with its plugin version. */
export interface PluginCodeModuleContent {
  readonly path: string;
  readonly content: string;
}

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
  /** The code modules stored with a plugin version, by path. */
  readonly codeModules: (
    id: PluginId,
    version: PluginVersion,
  ) => Effect.Effect<
    ReadonlyArray<PluginCodeModuleContent>,
    BundleRepositoryFailure
  >;
  /**
   * Every installed plugin of the workspaces `userId` actively belongs to,
   * with whether it is on and whether that workspace lets members run their
   * own copy instead ("allow personal plugin overrides").
   */
  readonly workspaceCopies: (userId: string) => Effect.Effect<
    ReadonlyArray<{
      readonly name: string;
      readonly workspaceName: string;
      readonly enabled: boolean;
      readonly overridesAllowed: boolean;
    }>,
    BundleRepositoryFailure
  >;
  /** Names every plugin row in the target, code plugins included. */
  readonly names: (
    target: PluginTarget,
  ) => Effect.Effect<ReadonlyArray<string>, BundleRepositoryFailure>;
  readonly insert: (
    bundle: StoredPluginBundle,
    codeModules?: ReadonlyArray<PluginCodeModuleContent>,
  ) => Effect.Effect<void, BundleRepositoryFailure | PluginIntegrityConflict>;
  /**
   * Records a new version of an installed bundle and makes it active. A
   * version with the active one's integrity is an integrity conflict.
   */
  readonly insertVersion: (
    bundle: StoredPluginBundle,
    codeModules?: ReadonlyArray<PluginCodeModuleContent>,
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
