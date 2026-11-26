import { pluginRebuildMessage } from "@dx/domain";

/**
 * The Plugins page's routes from memory, for its Storybook stories: three
 * installed plugins (one of only skills, one with code, one with views and
 * an MCP server, and one that uses a removed feature, its own container,
 * and must be rebuilt), their files, this month's activity,
 * and edits saved as new versions.
 */

/** Which page the story shows, and as whom. */
export type PluginsFixtureScene =
  | "personal"
  | "workspace-admin"
  | "workspace-member"
  | "empty";

const integrity = (seed: number) => seed.toString(16).padStart(64, "0");

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;

interface FixtureData {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly version?: string;
  readonly integrity: string;
  readonly source: unknown;
  readonly code?: {
    readonly [key: string]: unknown;
    readonly settings?: ReadonlyArray<unknown>;
  };
}

interface FixturePlugin {
  data: FixtureData;
  files: Record<string, string>;
}

const releaseNotes = (): FixturePlugin => ({
  data: {
    id: "plg_00000000-0000-4000-8000-000000000001",
    name: "release-notes",
    displayName: "Release notes",
    description:
      "Writes release notes and changelog entries from merged pull requests.",
    version: "1.2.0",
    enabled: true,
    source: { type: "zip", label: "release-notes.zip" },
    integrity: integrity(1),
    skills: [
      {
        id: "skl_00000000-0000-4000-8000-000000000001",
        name: "release-notes",
        enabled: true,
      },
      {
        id: "skl_00000000-0000-4000-8000-000000000002",
        name: "changelog",
        enabled: true,
      },
    ],
    mcpServers: [],
    localMcpServers: [],
    skipped: [],
  },
  files: {
    "plugin.json": json({
      name: "release-notes",
      displayName: "Release notes",
      version: "1.2.0",
      description:
        "Writes release notes and changelog entries from merged pull requests.",
    }),
    "README.md":
      "# Release notes\n\nAsk dx to **write the release notes** for a version. It reads the merged pull requests since the last tag and groups them by area.\n\n## Skills\n\n- `release-notes`: the notes for one release.\n- `changelog`: one entry in CHANGELOG.md.\n",
    "skills/release-notes/SKILL.md": skillMd(
      "release-notes",
      "Write release notes for a version from merged pull requests.",
      "# Release notes\n\n1. List the pull requests merged since the last tag.\n2. Group them by area.\n3. Write one line per change, in the past tense.",
    ),
    "skills/changelog/SKILL.md": skillMd(
      "changelog",
      "Add one entry to CHANGELOG.md.",
      "# Changelog\n\nAdd the entry under `## Unreleased`.",
    ),
  },
});

const logWatchManifest = (network: ReadonlyArray<string>) => ({
  name: "log-watch",
  displayName: "Log watch",
  version: "0.4.0",
  description: "Watches your Google Cloud logs and posts new errors.",
  extensions: {
    "dev.dxcode": {
      apiVersion: 1,
      host: "index.js",
      permissions: {
        events: ["session.start"],
        network,
        secrets: ["GCP_KEY"],
        tools: [],
        ai: true,
        threads: ["post"],
      },
    },
  },
});

const logWatchCode = (network: ReadonlyArray<string>) => ({
  apiVersion: 1,
  host: "worker",
  entry: "index.js",
  modules: [{ path: "index.js", bytes: 412, integrity: integrity(20) }],
  permissions: {
    events: ["session.start"],
    network: [...network],
    secrets: ["GCP_KEY"],
    tools: [],
    ai: true,
    threads: ["post"],
  },
  schedules: [{ name: "check", every: "15m" }],
  settings: [
    {
      key: "project",
      label: "Google Cloud project",
      type: "string",
      required: true,
    },
  ],
});

const logWatch = (): FixturePlugin => ({
  data: {
    id: "plg_00000000-0000-4000-8000-000000000002",
    name: "log-watch",
    displayName: "Log watch",
    description: "Watches your Google Cloud logs and posts new errors.",
    version: "0.4.0",
    enabled: true,
    source: {
      type: "github",
      repository: "acme/dx-plugins",
      ref: "main",
      path: "log-watch",
      commit: "4f1c2a9b7e3d5f60718293a4b5c6d7e8f9012345",
    },
    integrity: integrity(2),
    skills: [],
    mcpServers: [],
    localMcpServers: [],
    code: logWatchCode(["logging.googleapis.com"]),
    skipped: [],
  },
  files: {
    "plugin.json": json(logWatchManifest(["logging.googleapis.com"])),
    "README.md":
      "# Log watch\n\nEvery 15 minutes, reads new errors from Cloud Logging and posts them to the Thread you named.\n",
    "index.js":
      'import { definePlugin } from "@dxcode/plugin";\n\nexport default definePlugin((dx) => {\n  dx.on("session.start", async (_event, ctx) => {\n    ctx.log("Log watch is on.");\n  });\n});\n',
  },
});

const deployBoard = (): FixturePlugin => ({
  data: {
    id: "plg_00000000-0000-4000-8000-000000000003",
    name: "deploy-board",
    displayName: "Deploy board",
    description: "A board of this week's deploys, as a page and a Thread tab.",
    version: "2.0.1",
    enabled: false,
    source: { type: "zip", label: "deploy-board.zip" },
    integrity: integrity(3),
    skills: [],
    mcpServers: [
      {
        id: "mcp_00000000-0000-4000-8000-000000000001",
        name: "deploys",
        endpoint: "https://deploys.acme.dev/mcp",
        reviewed: false,
      },
    ],
    localMcpServers: [],
    code: {
      apiVersion: 1,
      host: "worker",
      entry: "index.js",
      modules: [{ path: "index.js", bytes: 300, integrity: integrity(30) }],
      permissions: {
        events: [],
        network: ["deploys.acme.dev"],
        secrets: [],
        tools: [],
        ai: false,
        ui: ["pane"],
      },
      settings: [],
      views: {
        tabs: [{ id: "deploys", title: "Deploys" }],
        pages: [{ id: "board", title: "Deploy board", path: "/" }],
        threadTypes: [],
      },
    },
    skipped: [],
  },
  files: {
    "plugin.json": json({
      name: "deploy-board",
      displayName: "Deploy board",
      version: "2.0.1",
      mcpServers: { deploys: { url: "https://deploys.acme.dev/mcp" } },
    }),
    "index.js":
      'export default (dx) => {\n  dx.registerView("board", () => "<dx-table></dx-table>");\n};\n',
    "assets/icon.png": "",
  },
});

/** A plugin built for its own container, which dx no longer runs. */
const uptimePinger = (): FixturePlugin => ({
  data: {
    id: "plg_00000000-0000-4000-8000-000000000004",
    name: "uptime-pinger",
    displayName: "Uptime pinger",
    description: "Pings our status page every 5 minutes.",
    version: "0.1.0",
    enabled: true,
    source: { type: "zip", label: "uptime-pinger.zip" },
    integrity: integrity(4),
    skills: [],
    mcpServers: [],
    localMcpServers: [],
    code: {
      apiVersion: 1,
      host: "worker",
      entry: "index.js",
      modules: [{ path: "index.js", bytes: 200, integrity: integrity(40) }],
      permissions: {
        events: [],
        network: ["status.acme.dev"],
        secrets: [],
        tools: [],
        ai: false,
      },
      settings: [],
    },
    // Core lists a removed feature under what it skipped
    // (settings/plugins/bundles/repository-d1.ts), and the plugin does not load.
    skipped: [
      {
        path: "plugin.json#extensions.dev.dxcode",
        reason:
          pluginRebuildMessage({ hosts: { container: "index.js" } }) ?? "",
      },
    ],
  },
  files: {
    "plugin.json": json({ name: "uptime-pinger", version: "0.1.0" }),
    "index.js":
      'export async function ping(ctx) {\n  await ctx.fetch("https://status.acme.dev");\n}\n',
  },
});

/** Answers the Plugins routes from memory; returns the restore. */
export const installPluginsApi = (scene: PluginsFixtureScene) => {
  const original = window.fetch;
  const workspace = scene.startsWith("workspace");
  const plugins =
    scene === "empty"
      ? []
      : [releaseNotes(), logWatch(), deployBoard(), uptimePinger()].map(
          (plugin): FixturePlugin => ({
            ...plugin,
            data: {
              ...plugin.data,
              scope: workspace ? "workspace" : "personal",
              installedAt: "2026-11-10T12:00:00.000Z",
              updatedAt: "2026-11-20T12:00:00.000Z",
            },
          }),
        );
  const canMutate = scene !== "workspace-member";
  const ok = (data: unknown, status = 200) =>
    Response.json({ status: "success", data }, { status });
  const fail = (message: string, status = 400) =>
    Response.json(
      {
        status: "error",
        data: { code: "PLUGIN_BUNDLE_REJECTED", message, requestId: "req" },
      },
      { status },
    );
  const find = (id: string) => plugins.find((plugin) => plugin.data.id === id);
  const preview = (plugin: FixturePlugin, files: Record<string, string>) => {
    const before = JSON.parse(plugin.files["plugin.json"] ?? "{}");
    const after = JSON.parse(files["plugin.json"] ?? "{}");
    const hosts = (manifest: {
      extensions?: Record<string, { permissions?: { network?: string[] } }>;
    }) => manifest.extensions?.["dev.dxcode"]?.permissions?.network ?? [];
    const added = hosts(after).filter((host) => !hosts(before).includes(host));
    return {
      manifest: {
        format: "agent-plugins",
        name: plugin.data.name,
        displayName: plugin.data.displayName,
        description: plugin.data.description,
        version: after.version ?? plugin.data.version,
        skills: [],
        mcpServers: [],
        skipped: [],
      },
      source: plugin.data.source,
      integrity: integrity(
        Number.parseInt(String(plugin.data.integrity), 16) + 100,
      ),
      conflicts: [],
      upToDate: false,
      permissions: {
        widens: added.length > 0,
        changes:
          added.length === 0
            ? []
            : [{ permission: "network", added, removed: [] }],
      },
      skills: [],
      mcpServers: [],
    };
  };
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.origin,
    );
    const path = url.pathname.replace(
      /^\/v1\/settings\/(personal|workspaces\/[^/]+)/,
      "",
    );
    const method = init?.method ?? "GET";
    if (path === "/first-party-plugins")
      return ok({
        scope: workspace ? "workspace" : "personal",
        canUpdate: canMutate,
        plugins: [],
      });
    if (path === "/plugin-bundles" && method === "GET")
      return ok({
        items: plugins.map(({ data }) => data),
        canMutate,
        proposals: [],
        ...(workspace
          ? { personalOverridesAllowed: true, repositoryPluginsAllowed: true }
          : {}),
      });
    if (path === "/plugin-bundles/updates")
      return ok({
        items: [{ pluginId: plugins[1]?.data.id, available: true }].filter(
          ({ pluginId }) => pluginId !== undefined,
        ),
      });
    const match = /^\/plugin-bundles\/(plg_[^/]+)(\/.*)?$/.exec(path);
    const plugin = match === null ? undefined : find(match[1] ?? "");
    if (plugin === undefined || match === null) return original(input, init);
    const rest = match[2] ?? "";
    if (rest === "/files")
      return method === "GET"
        ? ok({
            integrity: plugin.data.integrity,
            files: Object.entries(plugin.files)
              .map(([file, content]) => ({
                path: file,
                bytes: content.length === 0 ? 2048 : content.length,
                text: content.length > 0,
              }))
              .toSorted((left, right) => left.path.localeCompare(right.path)),
          })
        : (() => {
            const body = JSON.parse(String(init?.body)) as {
              files: Array<{ path: string; content: string }>;
              acceptPermissions?: boolean;
            };
            const next = { ...plugin.files };
            for (const file of body.files) next[file.path] = file.content;
            const reviewed = preview(plugin, next);
            if (reviewed.permissions.widens && body.acceptPermissions !== true)
              return fail(
                "This version asks for more permissions. Review them and accept to update.",
              );
            plugin.files = next;
            plugin.data = {
              ...plugin.data,
              integrity: reviewed.integrity,
              version: reviewed.manifest.version,
            };
            return ok(plugin.data);
          })();
    if (rest === "/files/content") {
      const content = plugin.files[url.searchParams.get("path") ?? ""];
      return content === undefined
        ? fail("Plugin not found.", 404)
        : ok({ path: url.searchParams.get("path"), content });
    }
    if (rest === "/files/preview") {
      const body = JSON.parse(String(init?.body)) as {
        files: Array<{ path: string; content: string }>;
      };
      const next = { ...plugin.files };
      for (const file of body.files) next[file.path] = file.content;
      return ok(preview(plugin, next));
    }
    if (rest === "/host-usage")
      return ok({
        month: "2026-11",
        lines:
          plugin.data.name === "log-watch"
            ? [
                {
                  host: "worker",
                  unitsMs: 92_000,
                  requests: 3_892,
                  blocked: 0,
                  costMicroUsd: 420_000,
                },
              ]
            : [],
      });
    if (rest === "/jobs")
      return ok({
        available: true,
        jobs: [
          {
            id: "check",
            title: "Check for new errors",
            schedule: { every: "15m" },
            status: "scheduled",
            nextRunAt: Date.now() + 9 * 60_000,
            lastRunAt: Date.now() - 6 * 60_000,
            lastOutcome: "ok",
            runs: 2_688,
          },
        ],
        watches: [],
        storage: { sqlBytes: 40_960, blobBytes: 0 },
        jobLimit: 20,
        canMutate,
      });
    if (rest === "/settings")
      return ok({
        settings: (plugin.data.code?.settings ?? []).map((setting) => ({
          ...(setting as object),
          value: "acme-prod",
        })),
      });
    return original(input, init);
  };
  return () => {
    window.fetch = original;
  };
};
