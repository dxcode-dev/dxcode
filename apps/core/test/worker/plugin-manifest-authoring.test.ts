import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PluginBundleRejected } from "../../src/settings/plugins/bundles/errors.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";

/**
 * A plugin written from the building-plugins skill alone, read by the real
 * manifest reader, and the mistakes an author or agent makes writing one.
 * What can go wrong for the author, each case below:
 * - the plugin the skill describes (a schedule and a URL listener for its
 *   function code, an icon set, a view described as data that is also a
 *   Thread type) is refused or loses a field, or its schedule and listener
 *   events are not granted, so dx never sends them;
 * - a typo inside an entry (a schedule, listener, view, export, setting,
 *   binary, or the icon) is dropped with no word, so the plugin quietly
 *   acts on the default;
 * - a plugin that uses a removed feature (`tier`, `jobs`, `durableScope`,
 *   `host.durable`, `host.container`, `permissions.wake`) loads half instead
 *   of saying it must be rebuilt;
 * - a listener watches a host `permissions.network` does not list, or runs
 *   a command with no service to receive it;
 * - a bad value inside an entry is reported as a different field;
 * - an unknown Lucide name on a view is kept and draws nothing;
 * - a misspelt permission, scope, or host turns the code off without
 *   saying which field;
 * - a removed feature (panes, their connect, the pane UI grant, views drawn
 *   by code) turns the whole code layer off, or is dropped without saying
 *   what to use instead;
 * - the default (`host` "worker") changes.
 */

const SCHEMA = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0F766E"/></svg>';

type Block = Record<string, unknown>;

/** The skill's plugin: a schedule, a URL listener, and a view that is a Thread type. */
const skillPlugin: Block = {
  apiVersion: 1,
  entry: "dev.dxcode/index.js",
  schedules: [{ name: "check-ci", every: "5m" }],
  listeners: [{ name: "deploys", url: "wss://events.example.com/deploys" }],
  permissions: {
    network: ["api.github.com", "events.example.com"],
    secrets: ["GITHUB_TOKEN"],
    threads: ["create", "post"],
  },
  icon: { src: "assets/icon.svg", background: "#0F766E" },
  archivedThreads: "show",
  views: [
    {
      id: "room",
      title: "CI room",
      icon: "lucide:siren",
      file: "views/room.json",
      show: ["page", "app"],
    },
  ],
};

const ROOM_VIEW = JSON.stringify({
  title: "CI room",
  state: { status: "unknown" },
  parts: [{ type: "stat", label: "CI", bind: "status" }],
});

const WORKER = `export default (dx) => {
  dx.registerCommand({ id: "check", title: "Check CI", run: async () => {} });
};`;
const ORB = `import { createServer } from "node:http";
let server;
export default (dx) => dx.expose({
  async start() {
    server ??= createServer((_req, res) => res.end("hello")).listen(8411, "127.0.0.1");
    return { port: 8411 };
  },
});`;

const files = (
  block: Block,
  extra: ReadonlyArray<FixtureEntry> = [],
): ReadonlyArray<FixtureEntry> => [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: SCHEMA,
      name: "ci-room",
      version: "1.0.0",
      description: "Watches CI in a room.",
      extensions: { "dev.dxcode": block },
    }),
  },
  { name: "dev.dxcode/index.js", content: WORKER },
  { name: "assets/icon.svg", content: ICON },
  { name: "dev.dxcode/orb/main.js", content: ORB },
  { name: "views/room.json", content: ROOM_VIEW },
  ...extra,
];

const read = async (block: Block, extra: ReadonlyArray<FixtureEntry> = []) => {
  const archive = await Effect.runPromise(
    readZipArchive(await buildZip(files(block, extra)), {
      maxArchiveBytes: 10_000_000,
      maxEntries: 1000,
    }),
  );
  return Effect.runPromise(
    Effect.result(readPluginBundle(archive, { root: "", fallbackName: "x" })),
  );
};

const accepted = async (
  block: Block,
  extra: ReadonlyArray<FixtureEntry> = [],
) => {
  const result = await read(block, extra);
  if (result._tag !== "Success") throw result.failure;
  const { manifest } = result.success;
  if (manifest.code === undefined)
    throw new Error(
      `The code layer is off: ${JSON.stringify(manifest.skipped)}`,
    );
  return { code: manifest.code, manifest, skipped: manifest.skipped };
};

/** Why dx turned the code layer off: the only importable thing was code. */
const codeOff = async (block: Block) => {
  const result = await read(block);
  if (result._tag !== "Failure")
    throw new Error("Expected the code to be off.");
  expect(result.failure).toBeInstanceOf(PluginBundleRejected);
  return (result.failure as PluginBundleRejected).reason;
};

const LABEL = "plugin.json#extensions.dev.dxcode";
const with_ = (patch: Block): Block => ({ ...skillPlugin, ...patch });

describe("a plugin written from the building-plugins skill", () => {
  it("reads whole, with nothing skipped", async () => {
    const { code, manifest, skipped } = await accepted(skillPlugin);
    expect(skipped).toEqual([]);
    expect(code.entry).toBe("dev.dxcode/index.js");
    expect(code.service).toBeUndefined();
    expect(code.schedules).toEqual([{ name: "check-ci", every: "5m" }]);
    expect(code.listeners).toEqual([
      { name: "deploys", url: "wss://events.example.com/deploys" },
    ]);
    // Declaring them grants their events, so dx sends them.
    expect(code.permissions.events).toEqual(
      expect.arrayContaining(["job.run", "listener.event"]),
    );
    expect(code.permissions.threads).toEqual(["create", "post"]);
    expect(
      code.dataViews?.map(({ id, title, icon, show }) => ({
        id,
        title,
        icon,
        show,
      })),
    ).toEqual([
      {
        id: "room",
        title: "CI room",
        icon: "lucide:siren",
        show: ["page", "app"],
      },
    ]);
    expect(manifest.iconSet?.src).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.iconSet?.background?.toLowerCase()).toBe("#0f766e");
  });
});

describe("typos inside entries are reported, not dropped silently", () => {
  it.each([
    [
      "a schedule",
      { schedules: [{ name: "check-ci", every: "5m", tz: "UTC" }] },
      "schedules[0].tz",
    ],
    [
      "a listener",
      {
        listeners: [
          {
            name: "deploys",
            url: "wss://events.example.com/deploys",
            headers: {},
          },
        ],
      },
      "listeners[0].headers",
    ],
    [
      "a view",
      {
        views: [
          {
            id: "room",
            title: "CI room",
            file: "views/room.json",
            shows: ["app"],
          },
        ],
      },
      "views[0].shows",
    ],
    [
      "an export",
      {
        exports: [{ name: "status", description: "Status.", descripton: "x" }],
      },
      "exports[0].descripton",
    ],
    [
      "a setting",
      {
        settings: [
          { key: "team", label: "Team", type: "string", requird: true },
        ],
      },
      "settings[0].requird",
    ],
    [
      "a binary",
      {
        host: { worker: "dev.dxcode/index.js", orb: "dev.dxcode/orb/main.js" },
        permissions: { ...(skillPlugin.permissions as Block), shell: true },
        binaries: [{ name: "jq", apt: "jq", version: "1.7" }],
      },
      "binaries[0].version",
    ],
    [
      "the icon",
      { icon: { src: "assets/icon.svg", darkmode: "assets/icon.svg" } },
      "icon.darkmode",
    ],
  ])("%s", async (_what, patch, field) => {
    const { skipped } = await accepted(with_(patch));
    expect(skipped).toContainEqual({
      path: `${LABEL}.${field}`,
      reason: "Not a dx field; ignored.",
    });
  });
});

describe("a bad value names its own field", () => {
  it("names an export's name", async () => {
    const reason = await codeOff(
      with_({ exports: [{ name: "Status!", description: "Status." }] }),
    );
    expect(reason).toContain("exports[0].name");
  });

  it.each([
    [
      {
        listeners: [{ name: "deploys", url: "wss://other.example.net/feed" }],
      },
      "watches other.example.net, which permissions.network does not list",
    ],
    [
      { listeners: [{ name: "tail", run: "tail -F app.log" }] },
      "runs a command on the plugin's service",
    ],
  ])("%j", async (patch, message) => {
    expect(await codeOff(with_(patch))).toContain(message);
  });
});

describe("a plugin that uses a removed feature must be rebuilt", () => {
  it.each([
    [{ tier: "workspace-trusted" }, "tier"],
    [{ jobs: [{ id: "a", title: "A", schedule: { every: "5m" } }] }, "jobs"],
    [{ durableScope: "install" }, "durableScope"],
    [
      { host: { worker: "dev.dxcode/index.js", durable: "dev.dxcode/a.js" } },
      "host.durable",
    ],
    [
      {
        host: { worker: "dev.dxcode/index.js", container: "dev.dxcode/a.js" },
      },
      "host.container",
    ],
    [
      { permissions: { ...(skillPlugin.permissions as Block), wake: true } },
      "permissions.wake",
    ],
  ])("%j", async (patch, feature) => {
    const reason = await codeOff(with_(patch));
    expect(reason).toContain(`uses ${feature}`);
    expect(reason).toContain("Rebuild it");
  });
});

describe("unknown Lucide names", () => {
  it("on a view are skipped with a reason and dropped", async () => {
    const { code, skipped } = await accepted(
      with_({
        views: [
          {
            id: "room",
            title: "Room",
            icon: "lucide:no-such-icon-zz",
            file: "views/room.json",
            show: ["page"],
          },
        ],
      }),
    );
    expect(skipped).toContainEqual({
      path: `${LABEL}.views[0].icon`,
      reason: "dx has no Lucide icon named no-such-icon-zz.",
    });
    expect(code.dataViews?.map(({ id }) => id)).toEqual(["room"]);
    expect(
      code.dataViews?.some((view) => view.icon === "lucide:no-such-icon-zz"),
    ).toBe(false);
  });
});

describe("removed features are skipped with what to use instead", () => {
  const USE_A_VIEW =
    "Describe the screen as a view: list it in views with a JSON file (see examples/plugins/log-watch).";

  it("skips panes, their connect, and the pane grant, and keeps the rest", async () => {
    const { code, skipped } = await accepted(
      with_({
        permissions: {
          ...(skillPlugin.permissions as Block),
          ui: ["pane", "notify"],
        },
        panes: [
          { id: "ci", title: "CI", connect: { portal: [8411], webrtc: true } },
        ],
      }),
    );
    expect(skipped).toEqual([
      {
        path: `${LABEL}.panes`,
        reason: `Plugin panes were removed. ${USE_A_VIEW}`,
      },
      {
        path: `${LABEL}.panes[0].connect`,
        reason: `A pane's hosts, Portal ports, and WebRTC were removed with plugin panes. ${USE_A_VIEW}`,
      },
      {
        path: `${LABEL}.permissions.ui`,
        reason: `The pane UI permission was removed with plugin panes; views need no permission. ${USE_A_VIEW}`,
      },
    ]);
    expect(code.permissions.ui).toEqual(["notify"]);
    expect(code.panes).toBeUndefined();
    expect(code.paneConnect).toBeUndefined();
    expect(code.dataViews?.map(({ id }) => id)).toEqual(["room"]);
    expect(code.schedules?.map(({ name }) => name)).toEqual(["check-ci"]);
  });

  it("skips views drawn by code (tabs, pages, Thread types)", async () => {
    const { code, skipped } = await accepted(
      with_({
        views: {
          tabs: [{ id: "room", title: "Room" }],
          threadTypes: [{ id: "t", title: "T", view: "room" }],
        },
      }),
    );
    expect(skipped).toEqual([
      {
        path: `${LABEL}.views`,
        reason:
          'Views drawn by plugin code (tabs, pages, and Thread types) were removed. List each view in views as a list entry with a JSON file and where it shows, such as show: ["page"]; a view with show: ["app"] is a Thread type (see examples/plugins/log-watch).',
      },
    ]);
    expect(code.views).toBeUndefined();
    expect(code.dataViews).toBeUndefined();
  });
});

describe("what still reads, and its defaults", () => {
  it("runs schedules in the entry module when there is no service", async () => {
    const { code } = await accepted(
      with_({ host: "worker", entry: "dev.dxcode/index.js" }),
    );
    expect(code.hosts).toBeUndefined();
    expect(code.entry).toBe("dev.dxcode/index.js");
    expect(code.schedules?.map(({ name }) => name)).toEqual(["check-ci"]);
  });

  it("reads the skill's Orb host example whole", async () => {
    const { code, skipped } = await accepted({
      apiVersion: 1,
      host: { worker: "dev.dxcode/index.js", orb: "dev.dxcode/orb/main.js" },
      binaries: [{ name: "jq", apt: "jq" }],
      permissions: { shell: true },
    });
    expect(skipped).toEqual([]);
    expect(code.hosts?.orb).toBe("dev.dxcode/orb/main.js");
    expect(code.binaries).toEqual([{ name: "jq", apt: "jq" }]);
  });
});
