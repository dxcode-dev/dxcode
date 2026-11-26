import {
  isStdioMcpServer,
  PLUGIN_PERMISSIONS,
  type PluginBundleCode,
  type PluginBundleManifest,
  type PluginCodePermissions,
  type PluginCodeThreadGrant,
  type PluginPermission,
  pluginHostKinds,
  pluginServiceGrants,
  pluginThreadGrants,
  RETIRED_PLUGIN_UI_GRANT,
} from "@dx/domain";

/**
 * What an update changes in the grants a person reviewed at install (plugin
 * plan §7): the code layer's permissions, the settings it asks for, and the
 * hosts its MCP servers reach. A version whose code asks for more needs a
 * new review; one that only keeps or drops grants updates with one click.
 */

export type { PluginPermission } from "@dx/domain";

export interface PluginPermissionChange {
  readonly permission: PluginPermission;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface PluginPermissionDiff {
  /** Whether the new version asks for anything the current one does not. */
  readonly widens: boolean;
  readonly changes: ReadonlyArray<PluginPermissionChange>;
}

type Grants = Pick<PluginBundleManifest, "code" | "mcpServers">;

const THREAD_GRANT_LABELS = {
  create: "start Threads",
  read: "read Threads",
  post: "post into Threads",
} as const satisfies Record<PluginCodeThreadGrant, string>;

/**
 * The row that compares each field a manifest's code layer grants: each key
 * of `permissions`, and each field of the code layer, with `null` for a field
 * that grants nothing. A key or field added to the schema fails the build here
 * until it is sorted, so an update cannot gain it without a new review.
 */
export const pluginGrantRows = {
  permissions: {
    events: "events",
    network: "network",
    secrets: "secrets",
    tools: "tools",
    ai: "ai",
    ui: "ui",
    threads: "threads",
    models: "models",
    agents: "agents",
    shell: "shell",
    plugins: "plugins",
  } as const satisfies {
    readonly [Key in keyof PluginCodePermissions]-?: PluginPermission;
  },
  code: {
    apiVersion: null,
    host: null,
    entry: "code",
    // The modules' contents change with every version; what they may reach
    // is in `permissions`.
    modules: null,
    permissions: "code",
    settings: "settings",
    agentModes: "agents",
    hosts: "hosts",
    binaries: "binaries",
    archivedThreads: null,
    iconAssets: null,
    dataViews: "views",
    exports: "exports",
    // Retired fields an old stored version may hold; they grant nothing.
    panes: null,
    views: null,
    paneConnect: null,
    // Schedules, listeners, and a program on a plugin Orb.
    service: "service",
    schedules: "service",
    listeners: "service",
  } as const satisfies {
    readonly [Key in keyof PluginBundleCode]-?: PluginPermission | null;
  },
};

const lists = (manifest: Grants) => {
  const code = manifest.code;
  const permissions = code?.permissions;
  return {
    code:
      code === undefined
        ? []
        : [
            "runs code",
            // ─── The Orb host is a new way to run ───
            ...(code.hosts?.orb === undefined
              ? []
              : [
                  "runs in each Thread's Orb with its files, environment, and secrets",
                ]),
          ],
    events: permissions?.events ?? [],
    network: permissions?.network ?? [],
    secrets: permissions?.secrets ?? [],
    tools: permissions?.tools ?? [],
    // The retired `pane` grant an old version may hold grants nothing.
    ui: (permissions?.ui ?? []).filter(
      (grant) => grant !== RETIRED_PLUGIN_UI_GRANT,
    ),
    ai: permissions?.ai === true ? ["model calls"] : [],
    threads: pluginThreadGrants(permissions?.threads).map(
      (grant) => THREAD_GRANT_LABELS[grant],
    ),
    models: permissions?.models ?? [],
    // Each declared mode is its own grant: a new one is a new way to run.
    agents:
      permissions?.agents === true
        ? [
            "Runs its agents as Threads",
            ...(code?.agentModes ?? []).map(
              ({ key, label }) => `${label} mode (${key})`,
            ),
          ]
        : [],
    shell: permissions?.shell === true ? ["run commands in the Orb"] : [],
    // A new required setting asks the installer for something; an optional
    // one does not change what the code may reach.
    settings: (code?.settings ?? []).flatMap(({ label, required }) =>
      required ? [label] : [],
    ),
    mcp: [
      ...new Set(
        manifest.mcpServers.flatMap((server) =>
          isStdioMcpServer(server) ? [] : [new URL(server.endpoint).host],
        ),
      ),
    ],
    // A local MCP server runs this command in the Thread's Orb.
    commands: [
      ...new Set(
        manifest.mcpServers.flatMap((server) =>
          isStdioMcpServer(server)
            ? [[server.command, ...server.args].join(" ")]
            : [],
        ),
      ),
    ],
    // A native tool the Orb host installs; a new source is a
    // new review.
    binaries: (code?.binaries ?? []).map(({ name, apt, url, sha256, path }) =>
      apt !== undefined
        ? `${name} (Debian package ${apt})`
        : url !== undefined
          ? `${name} (${url}${path === undefined ? "" : ` ${path}`}, sha256 ${sha256})`
          : `${name} (${path} in the plugin)`,
    ),
    // Other plugins it may call, and the views it draws.
    plugins: [...(permissions?.plugins ?? [])],
    views: (code?.dataViews ?? []).map(
      ({ title, show }) => `View: ${title} (${show.join(", ")})`,
    ),
    // A new export is something more other plugins may call.
    exports: (code?.exports ?? []).map(({ name }) => name),
    hosts:
      code === undefined
        ? []
        : pluginHostKinds(code).filter((kind) => kind !== "worker"),
    service: pluginServiceGrants(code),
  } satisfies Record<PluginPermission, ReadonlyArray<string>>;
};

export const pluginPermissionDiff = (
  current: Grants,
  next: Grants,
): PluginPermissionDiff => {
  const before = lists(current);
  const after = lists(next);
  const changes = PLUGIN_PERMISSIONS.flatMap((permission) => {
    const was = new Set(before[permission]);
    const now = new Set(after[permission]);
    const added = after[permission].filter((value) => !was.has(value));
    const removed = before[permission].filter((value) => !now.has(value));
    return added.length + removed.length === 0
      ? []
      : [{ permission, added, removed }];
  });
  return {
    // An added MCP host is listed, but its tools already wait for their own
    // approval in Integrations & MCP before any of them runs.
    widens: changes.some(
      ({ permission, added }) => permission !== "mcp" && added.length > 0,
    ),
    changes,
  };
};
