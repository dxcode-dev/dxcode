import {
  isStdioMcpServer,
  PLUGIN_TIERS,
  type PluginBundleManifest,
  type PluginCodeThreadGrant,
  pluginHostKinds,
  pluginThreadGrants,
  tierAtLeast,
} from "@dx/domain";

/**
 * What an update changes in the grants a person reviewed at install (plugin
 * plan §7): the code layer's permissions, the settings it asks for, and the
 * hosts its MCP servers reach. A version whose code asks for more needs a
 * new review; one that only keeps or drops grants updates with one click.
 */

export type PluginPermission =
  | "code"
  | "events"
  | "network"
  | "secrets"
  | "tools"
  | "ui"
  | "ai"
  | "threads"
  | "models"
  | "agents"
  | "shell"
  | "settings"
  | "mcp"
  | "commands"
  | "binaries"
  | "plugins"
  | "views"
  | "exports"
  // The tiers the manifest's `tier` ceiling lets it reach,
  // so raising the ceiling is a widening that needs a new review; and the
  // hosts and background jobs the trusted tiers unlock.
  | "tier"
  | "hosts"
  | "jobs";

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
    ui: permissions?.ui ?? [],
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
    // A native tool the Orb or container host installs; a new source is a
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
    views: [
      ...(code?.views?.tabs ?? []).map(({ title }) => `Tab: ${title}`),
      ...(code?.views?.pages ?? []).map(({ title }) => `Page: ${title}`),
      ...(code?.views?.threadTypes ?? []).map(
        ({ title }) => `Thread type: ${title}`,
      ),
    ],
    // A new export is something more other plugins may call.
    exports: (code?.exports ?? []).map(({ name }) => name),
    tier:
      code === undefined
        ? []
        : PLUGIN_TIERS.filter((tier) =>
            tierAtLeast(code.tier ?? "verified", tier),
          ),
    hosts:
      code === undefined
        ? []
        : pluginHostKinds(code).filter((kind) => kind !== "worker"),
    jobs: (() => {
      const jobs = (code as { readonly jobs?: unknown } | undefined)?.jobs;
      return Array.isArray(jobs)
        ? jobs.map((job, index) =>
            typeof job === "object" &&
            job !== null &&
            typeof (job as { id?: unknown }).id === "string"
              ? (job as { id: string }).id
              : `job ${index + 1}`,
          )
        : [];
    })(),
  } satisfies Record<PluginPermission, ReadonlyArray<string>>;
};

const order: ReadonlyArray<PluginPermission> = [
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
  "tier",
  "hosts",
  "jobs",
];

export const pluginPermissionDiff = (
  current: Grants,
  next: Grants,
): PluginPermissionDiff => {
  const before = lists(current);
  const after = lists(next);
  const changes = order.flatMap((permission) => {
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
