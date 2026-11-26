import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import {
  DATA_VIEW_PLACES,
  MAX_DATA_VIEW_BYTES,
  MAX_DATA_VIEWS,
} from "../plugins/data-view.js";
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
import { PluginCodeHosts } from "./plugin-host-kind.js";
import type {
  PluginIntegrityConflict,
  PluginNotFound,
} from "./plugin-repository.js";
import {
  MAX_PLUGIN_SERVICE_LISTENERS,
  MAX_PLUGIN_SERVICE_SCHEDULES,
  PluginService,
  PluginServiceListener,
  PluginServiceSchedule,
} from "./plugin-service.js";
import { MAX_SKILLS_PER_SCOPE, SkillDescription, SkillName } from "./skill.js";

/**
 * A plugin bundle in the Agent Plugins format (agent-plugins.org) or Claude
 * Code's format: its skills and MCP servers (remote, or local ones dxd runs
 * in the Orb) imported together as one
 * plugin row. They live in the Skills and MCP server
 * stores, linked back by plugin ID. Commands are Claude Code only and are not
 * imported.
 */

/**
 * A plugin's ZIP. 24 MiB (16 MiB until plugin services): a service ships its
 * program's files, which go into the package in R2, never into D1 rows.
 */
export const MAX_PLUGIN_ARCHIVE_BYTES = 24 * 1024 * 1024;
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

/**
 * The most bytes and files a plugin package (its folder, for the Orb) holds.
 * The package lives in R2 (`plugin-packages/<sha256>`) and only dxd reads
 * it, so a large one costs no request path a read. Files were 5,000 until
 * plugin services; a program's sources reach the archive's entry limit.
 */
export const MAX_PLUGIN_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_FILES = MAX_PLUGIN_ARCHIVE_ENTRIES;

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

// --- Plugin icons and archived Threads ---

/** A stored icon's sha256, in hex: its bytes live in `plugin_icon`. */
export const PluginIconHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
);

export type PluginIconHash = typeof PluginIconHash.Type;

/** A dx icon name an item may use instead of an asset: `lucide:<name>`. */
export const PLUGIN_LUCIDE_ICON_PATTERN = /^lucide:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * An item's icon as stored: `lucide:<name>`, or the hash of an icon file
 * the plugin carries.
 */
export const PluginIconRef = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^(?:lucide:[a-z0-9]+(?:-[a-z0-9]+)*|[0-9a-f]{64})$/),
);

export type PluginIconRef = typeof PluginIconRef.Type;

/**
 * The plugin's icon, from `extensions["dev.dxcode"].icon` or the legacy
 * `assets/icon.png` / `assets/icon.svg`: `src` on light, `dark` on dark
 * (else `monochrome` drawn in the text color, else `src` on a `background`
 * tile). Every file is a hash in `plugin_icon`.
 */
export const PluginIconSet = Schema.Struct({
  src: Schema.optional(PluginIconHash),
  dark: Schema.optional(PluginIconHash),
  monochrome: Schema.optional(PluginIconHash),
  background: Schema.optional(
    Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  ),
});

export type PluginIconSet = typeof PluginIconSet.Type;

/** At most this many icon files a plugin carries for its items. */
export const MAX_PLUGIN_ITEM_ICONS = 32;

/**
 * What a plugin does in an archived Thread: `hide` (default) nothing,
 * `show` its items read-only, `live` keeps its code working. `live` needs a
 * personal or workspace install (`effectiveArchivedMode`); a repository's
 * plugin is served as `hide`.
 */
export const PLUGIN_ARCHIVED_MODES = ["hide", "show", "live"] as const;

export const PluginArchivedMode = Schema.Literals(PLUGIN_ARCHIVED_MODES);

export type PluginArchivedMode = typeof PluginArchivedMode.Type;

/** dx's code layer: the events a plugin's code may handle. */
export const PLUGIN_CODE_EVENTS = [
  "session.start",
  "agent.start",
  "agent.end",
  "tool.call",
  "tool.result",
  "trigger.received",
  "changes.prompt",
  // Once when the Thread is archived or restored; 10 s, no Orb.
  "thread.archived",
  "thread.unarchived",
  // A manifest schedule's run, for a plugin without a service: { name, scheduledAt }.
  "job.run",
  // A message on a manifest listener's URL: { name, data }.
  "listener.event",
] as const;

export const PluginCodeEvent = Schema.Literals(PLUGIN_CODE_EVENTS);

/**
 * dx's own UI a plugin's code may show in a Thread: `prompt` asks with
 * `ctx.ui.confirm`, `input`, and `select` above the composer; `notify`
 * shows a toast; `quick-action` adds buttons above the composer.
 */
export const PLUGIN_CODE_UI_GRANTS = [
  "prompt",
  "notify",
  "quick-action",
] as const;

export const PluginCodeUiGrant = Schema.Literals(PLUGIN_CODE_UI_GRANTS);

/** The UI grant for plugin panes, removed on 2026-11-25. */
export const RETIRED_PLUGIN_UI_GRANT = "pane";

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

// ─── Views and plugin-to-plugin calls ──────────────────────────────────

/** A view's id: 1 to 48 lowercase letters, digits, and hyphens. */
export const PluginViewId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/),
);

const PluginViewTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
);

/**
 * A view described as data: the array form of the manifest's `views`. dx
 * draws its file (`data-view.ts`) with its own parts, in each place `show`
 * names. The file is stored with the version's files, by `file` and
 * `integrity` (the sha256 of its text).
 */
export const PluginDataViewEntry = Schema.Struct({
  id: PluginViewId,
  title: PluginViewTitle,
  icon: Schema.optional(PluginIconRef),
  show: Schema.Array(Schema.Literals(DATA_VIEW_PLACES)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DATA_VIEW_PLACES.length),
  ),
  file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  integrity: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  bytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_DATA_VIEW_BYTES }),
  ),
});

export type PluginDataViewEntry = typeof PluginDataViewEntry.Type;

/** A function other plugins may call with `ctx.plugins.call`. */
export const PluginExportName = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9_]{0,47}$/),
);

export const MAX_PLUGIN_EXPORTS = 16;
/** At most this many plugins one plugin may call. */
export const MAX_PLUGIN_CALL_TARGETS = 8;

export const PluginExport = Schema.Struct({
  name: PluginExportName,
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(300),
  ),
  inputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export type PluginExport = typeof PluginExport.Type;

/** A Thread type as stored on a Thread: `<plugin name>/<type id>`. */
export const PluginThreadTypeRef = Schema.String.check(
  Schema.isMaxLength(130),
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]{0,63}\/[a-z][a-z0-9-]{0,47}$/),
);

export type PluginThreadTypeRef = typeof PluginThreadTypeRef.Type;

/**
 * What a plugin's code may reach, declared under `extensions["dev.dxcode"]`
 * and shown before install. A capability not listed has no object in the
 * plugin's context.
 */
export const PluginCodePermissions = Schema.Struct({
  events: Schema.Array(PluginCodeEvent).check(Schema.isMaxLength(16)),
  /** Hosts `ctx.fetch` may reach; `*.example.com` covers subdomains. */
  network: Schema.Array(PluginCodeHost).check(Schema.isMaxLength(128)),
  /** Secret names from Secrets & Env Vars, in the install's scope. */
  secrets: Schema.Array(PluginCodeName).check(Schema.isMaxLength(32)),
  /** dx tools `ctx.tools.call` may call. */
  tools: Schema.Array(PluginCodeName).check(Schema.isMaxLength(64)),
  /** `ctx.ai`: model calls on the Thread's model route. */
  ai: Schema.Boolean,
  /**
   * dx UI in the Thread; absent in versions stored before it existed.
   * `pane` is the retired grant a version stored before 2026-11-25 may
   * hold: it decodes so the plugin's other features keep working, grants
   * nothing, and `pluginRebuildReason` says the plugin needs a rebuild.
   */
  ui: Schema.optional(
    Schema.Array(
      Schema.Union([
        PluginCodeUiGrant,
        Schema.Literal(RETIRED_PLUGIN_UI_GRANT),
      ]),
    ).check(Schema.isMaxLength(8)),
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
  /** Plugins whose `exports` `ctx.plugins.call` may call, by name. */
  plugins: Schema.optional(
    Schema.Array(PluginName).check(Schema.isMaxLength(MAX_PLUGIN_CALL_TARGETS)),
  ),
});

export type PluginCodePermissions = typeof PluginCodePermissions.Type;

/**
 * Each kind of grant an update review compares, in the order it lists them.
 * The diff (`permission-diff.ts`) must say which of these covers every key of
 * `PluginCodePermissions` and every field of `PluginBundleCode`.
 */
export const PLUGIN_PERMISSIONS = [
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
  "binaries",
  "plugins",
  "views",
  "exports",
  // The hosts its code runs in.
  "hosts",
  // Its schedules, its listeners, and a program on a plugin Orb.
  "service",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

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

// ─── Binaries ───
export const MAX_PLUGIN_BINARIES = 16;

/**
 * One native tool a plugin's Orb or container process needs: a Debian
 * package (`apt`), a file dx downloads and checks (`url` with `sha256`), or
 * a file in the plugin (`path` without `url`). `name` is the command put on
 * the process's PATH. A `url` ending in .zip, .tar.gz, .tgz, or .tar.xz is
 * unpacked, and `path` then names the executable inside it. Hosts download
 * `url` without a shell; the reader stores it normalized by `URL`.
 */
export const PluginCodeBinary = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  ),
  apt: Schema.optional(
    // Ends in a letter or digit: apt-get reads a trailing "-" as "remove".
    Schema.String.check(
      Schema.isPattern(/^[a-z0-9][a-z0-9.+-]{0,62}[a-z0-9]$/),
    ),
  ),
  url: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(2_048),
      Schema.isPattern(/^https:\/\/\S+$/),
    ),
  ),
  sha256: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  ),
  path: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  ),
});

export type PluginCodeBinary = typeof PluginCodeBinary.Type;
/**
 * A plugin's code layer: a JavaScript entry module under `dev.dxcode/` that
 * dx runs in an isolated Cloudflare Dynamic Worker. `modules` lists every
 * module stored with the version, entry first.
 */
export const PluginBundleCode = Schema.Struct({
  apiVersion: Schema.Literal(1),
  host: Schema.Literal("worker"),
  /**
   * The Worker's entry module. Absent only for a plugin whose code is a
   * `service` (any language, on a plugin Orb) with no JavaScript for dx to
   * run; such a plugin has no modules.
   */
  entry: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  modules: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      bytes: Schema.Int.check(
        Schema.isBetween({ minimum: 0, maximum: MAX_PLUGIN_CODE_MODULE_BYTES }),
      ),
      integrity: PluginIntegrity,
    }),
  ).check(Schema.isMaxLength(MAX_PLUGIN_CODE_MODULES)),
  permissions: PluginCodePermissions,
  settings: Schema.Array(PluginCodeSetting).check(Schema.isMaxLength(32)),
  /** Agent modes it declares; each needs `permissions.agents`. */
  agentModes: Schema.optional(
    Schema.Array(PluginAgentMode).check(
      Schema.isMaxLength(MAX_PLUGIN_AGENT_MODES),
    ),
  ),
  // ─── Hosts ───
  /**
   * Entry modules per host, from the manifest's object form of `host`.
   * `host` stays `"worker"` and `entry` the Worker entry, so rows stored
   * before hosts existed still decode; `hosts.worker`, when absent, is
   * `entry`. See `pluginHostEntry`.
   */
  hosts: Schema.optional(PluginCodeHosts),
  // ─── Binaries ───
  /** Native tools the Orb host installs before the plugin's process starts. */
  binaries: Schema.optional(
    Schema.Array(PluginCodeBinary).check(
      Schema.isMaxLength(MAX_PLUGIN_BINARIES),
    ),
  ),
  /** What the plugin shows in archived Threads; `hide` when absent. */
  archivedThreads: Schema.optional(PluginArchivedMode),
  /**
   * Icon files the plugin carries for its items, by path in the plugin
   * (`assets/phone.svg`): an item's `icon` naming one resolves to its hash.
   */
  iconAssets: Schema.optional(
    Schema.Record(Schema.String.check(Schema.isMaxLength(256)), PluginIconHash),
  ),
  /** Views described as data, from the array form of `views`. */
  dataViews: Schema.optional(
    Schema.Array(PluginDataViewEntry).check(Schema.isMaxLength(MAX_DATA_VIEWS)),
  ),
  /** Functions other plugins may call; its code `expose`s each. */
  exports: Schema.optional(
    Schema.Array(PluginExport).check(Schema.isMaxLength(MAX_PLUGIN_EXPORTS)),
  ),
  // ─── Schedules, listeners, and service ───
  /** A program dxd keeps running on a plugin Orb; see `PluginService`. */
  service: Schema.optional(PluginService),
  /**
   * Schedules dx runs: a call to the service when there is one, else a
   * `job.run` event for the function code.
   */
  schedules: Schema.optional(
    Schema.Array(PluginServiceSchedule).check(
      Schema.isMaxLength(MAX_PLUGIN_SERVICE_SCHEDULES),
    ),
  ),
  /**
   * Commands whose output lines are events for the service (`run`), or URLs
   * dx watches for the function code (`url`).
   */
  listeners: Schema.optional(
    Schema.Array(PluginServiceListener).check(
      Schema.isMaxLength(MAX_PLUGIN_SERVICE_LISTENERS),
    ),
  ),
  // ─── Retired ───
  /**
   * Plugin panes (`panes`, `paneConnect`) and views its code drew (the
   * object form of `views`), removed on 2026-11-25. A version stored before
   * then may hold them: they decode unread, so the plugin's other features
   * keep working, and `pluginRebuildReason` says it needs a rebuild. The
   * bundle reader never writes them.
   */
  panes: Schema.optional(Schema.Unknown),
  views: Schema.optional(Schema.Unknown),
  paneConnect: Schema.optional(Schema.Unknown),
});

export type PluginBundleCode = typeof PluginBundleCode.Type;

/**
 * Features a stored plugin's code asks for that dx no longer has: its own
 * container, the Durable Object `host.durable` entry and `durableScope`,
 * manifest `jobs`, `tier`, and `permissions.wake`. A plugin that uses any of
 * them does not load and must be rebuilt (schedules, URL listeners, and
 * `ctx.threads` replace them). Reads the stored JSON, since decoding drops
 * fields the schema no longer has.
 */
export const removedPluginFeatures = (code: unknown): ReadonlyArray<string> => {
  if (code === null || typeof code !== "object") return [];
  const raw = code as Readonly<Record<string, unknown>>;
  const hosts = (raw.hosts ?? {}) as Readonly<Record<string, unknown>>;
  const permissions = (raw.permissions ?? {}) as Readonly<
    Record<string, unknown>
  >;
  return [
    ...(hosts.container !== undefined ? ["host.container"] : []),
    ...(hosts.durable !== undefined ? ["host.durable"] : []),
    ...(raw.durableScope !== undefined ? ["durableScope"] : []),
    ...(raw.jobs !== undefined ? ["jobs"] : []),
    ...(raw.tier !== undefined ? ["tier"] : []),
    ...(permissions.wake !== undefined ? ["permissions.wake"] : []),
  ];
};

const REBUILD_PREFIX = "This plugin uses ";
const REBUILD_SUFFIX =
  ", which dx no longer runs. Rebuild it with schedules, listeners, and ctx.threads, then update it.";

/** Whether a skipped entry's reason is `pluginRebuildMessage`'s sentence. */
export const isPluginRebuildMessage = (reason: string) =>
  reason.startsWith(REBUILD_PREFIX) && reason.endsWith(REBUILD_SUFFIX);

/** The sentence a plugin that uses removed features shows, or undefined. */
export const pluginRebuildMessage = (code: unknown): string | undefined => {
  const removed = removedPluginFeatures(code);
  return removed.length === 0
    ? undefined
    : `${REBUILD_PREFIX}${
        removed.length === 1
          ? removed[0]
          : `${removed.slice(0, -1).join(", ")} and ${removed.at(-1)}`
      }${REBUILD_SUFFIX}`;
};

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
  /** The plugin's icon files by hash; absent before icons were hashed. */
  iconSet: Schema.optional(PluginIconSet),
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

/** An icon file stored by its sha256 in `plugin_icon`. */
export interface PluginIconFileContent {
  readonly hash: string;
  readonly mediaType: "image/png" | "image/svg+xml";
  readonly bytes: Uint8Array;
}

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
    /** Icon files, stored by hash with the version. */
    iconFiles?: ReadonlyArray<PluginIconFileContent>,
  ) => Effect.Effect<void, BundleRepositoryFailure | PluginIntegrityConflict>;
  /**
   * Records a new version of an installed bundle and makes it active. A
   * version with the active one's integrity is an integrity conflict.
   */
  readonly insertVersion: (
    bundle: StoredPluginBundle,
    codeModules?: ReadonlyArray<PluginCodeModuleContent>,
    /** Icon files, stored by hash with the version. */
    iconFiles?: ReadonlyArray<PluginIconFileContent>,
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
