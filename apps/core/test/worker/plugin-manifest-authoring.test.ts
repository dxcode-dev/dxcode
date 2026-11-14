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
 * - the plugin the skill describes (a durable job, a UI-kit pane, an icon
 *   set, a tab drawn as a Thread type) is refused or loses a field;
 * - a typo inside an entry (a pane, job, view, export, setting, binary, or
 *   the icon) is dropped with no word, so the plugin quietly acts on the
 *   default;
 * - a bad value inside a view entry is reported as a different field;
 * - a tab or page reuses a pane's id, which the manifest accepts and the
 *   code's `registerView` then refuses in every Thread;
 * - an unknown Lucide name on a view is kept, where a pane's is skipped,
 *   and draws nothing;
 * - a misspelt permission, scope, or host turns the code off without
 *   saying which field;
 * - the defaults (Thread type `chat`, `host` "worker") change.
 */

const SCHEMA = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0F766E"/></svg>';

type Block = Record<string, unknown>;

/** The skill's plugin: a thread-scoped durable job, a pane, a tab Thread type. */
const skillPlugin: Block = {
  apiVersion: 1,
  host: { worker: "dev.dxcode/index.js", durable: "dev.dxcode/live.js" },
  durableScope: "thread",
  jobs: [{ id: "check-ci", title: "Check CI", schedule: { every: "5m" } }],
  permissions: {
    network: ["api.github.com"],
    secrets: ["GITHUB_TOKEN"],
    ui: ["pane"],
    wake: true,
  },
  icon: { src: "assets/icon.svg", background: "#0F766E" },
  archivedThreads: "show",
  panes: [{ id: "ci", title: "CI", icon: "lucide:activity" }],
  views: {
    tabs: [{ id: "room", title: "CI room", icon: "lucide:siren" }],
    threadTypes: [
      { id: "ci-room", title: "CI room", view: "room", chat: "side" },
    ],
  },
};

const WORKER = `export default (dx) => {
  dx.registerPane({ id: "ci", title: "CI", html: '<script type="module" src="dx:plugin-ui"></script><dx-card heading="CI"></dx-card>' });
  dx.registerView({ id: "room", html: "<!doctype html><main>Room</main>" });
};`;
const DURABLE = `export default (dx) => dx.registerJob({
  id: "check-ci",
  run: async (_data, ctx) => { await ctx.panes.get("ci").post({ checked: Date.now() }); },
});`;

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
  { name: "dev.dxcode/live.js", content: DURABLE },
  { name: "assets/icon.svg", content: ICON },
  { name: "dev.dxcode/orb/main.js", content: ORB },
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
    expect(code.hosts).toEqual({
      worker: "dev.dxcode/index.js",
      durable: "dev.dxcode/live.js",
    });
    expect(code.durableScope).toBe("thread");
    expect(code.jobs).toEqual([
      { id: "check-ci", title: "Check CI", schedule: { every: "5m" } },
    ]);
    expect(code.permissions.wake).toBe(true);
    expect(code.panes).toEqual([
      { id: "ci", title: "CI", icon: "lucide:activity" },
    ]);
    expect(code.views?.tabs).toEqual([
      { id: "room", title: "CI room", icon: "lucide:siren" },
    ]);
    expect(code.views?.threadTypes).toEqual([
      { id: "ci-room", title: "CI room", view: "room", chat: "side" },
    ]);
    expect(manifest.iconSet?.src).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.iconSet?.background?.toLowerCase()).toBe("#0f766e");
  });
});

describe("typos inside entries are reported, not dropped silently", () => {
  it.each([
    [
      "a pane",
      { panes: [{ id: "ci", title: "CI", archivedThread: "show" }] },
      "panes[0].archivedThread",
    ],
    [
      "a job",
      {
        jobs: [
          {
            id: "check-ci",
            title: "Check CI",
            schedule: { every: "5m" },
            shedule: 1,
          },
        ],
      },
      "jobs[0].shedule",
    ],
    [
      "a job's schedule",
      {
        jobs: [
          {
            id: "check-ci",
            title: "Check CI",
            schedule: { every: "5m", tz: "UTC" },
          },
        ],
      },
      "jobs[0].schedule.tz",
    ],
    [
      "views",
      { views: { ...(skillPlugin.views as Block), tab: [] } },
      "views.tab",
    ],
    [
      "a tab",
      {
        views: {
          tabs: [{ id: "room", title: "CI room", archived: "show" }],
        },
      },
      "views.tabs[0].archived",
    ],
    [
      "a Thread type",
      {
        views: {
          tabs: [{ id: "room", title: "CI room" }],
          threadTypes: [{ id: "t", title: "T", view: "room", chats: "hidden" }],
        },
      },
      "views.threadTypes[0].chats",
    ],
    [
      "an export",
      {
        exports: [{ name: "status", description: "Status.", descripton: "x" }],
      },
      "exports[0].descripton",
    ],
    [
      "a pane's connect",
      {
        panes: [{ id: "ci", title: "CI", connect: { portals: [8411] } }],
      },
      "panes[0].connect.portals",
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
  it("names a tab's archivedThreads, not its id and title", async () => {
    const reason = await codeOff(
      with_({
        views: {
          tabs: [{ id: "room", title: "CI room", archivedThreads: "keep" }],
        },
      }),
    );
    expect(reason).toContain("views.tabs[0].archivedThreads");
    expect(reason).toContain("hide, show, live");
    expect(reason).not.toContain("needs an id");
  });

  it("names a Thread type's chat", async () => {
    const reason = await codeOff(
      with_({
        views: {
          tabs: [{ id: "room", title: "CI room" }],
          threadTypes: [{ id: "t", title: "T", view: "room", chat: "aside" }],
        },
      }),
    );
    expect(reason).toContain("views.threadTypes[0].chat");
    expect(reason).toContain("side or hidden");
  });

  it("names a page's path", async () => {
    const reason = await codeOff(
      with_({
        views: { pages: [{ id: "board", title: "Board", path: "open" }] },
      }),
    );
    expect(reason).toContain("views.pages[0].path");
  });

  it("names an export's name", async () => {
    const reason = await codeOff(
      with_({ exports: [{ name: "Status!", description: "Status." }] }),
    );
    expect(reason).toContain("exports[0].name");
  });

  it.each([
    [
      { permissions: { ...(skillPlugin.permissions as Block), wake: "yes" } },
      "permissions.wake must be true or false.",
    ],
    [{ durableScope: "Thread" }, "durableScope must be install or thread."],
  ])("%j", async (patch, message) => {
    expect(await codeOff(with_(patch))).toContain(message);
  });
});

describe("panes and views share one id namespace", () => {
  it("refuses a tab that reuses a pane's id", async () => {
    const reason = await codeOff(
      with_({ views: { tabs: [{ id: "ci", title: "CI tab" }] } }),
    );
    expect(reason).toContain("ci");
    expect(reason).toMatch(/pane and a view share the id ci/);
  });

  it("refuses a page that reuses a tab's id", async () => {
    const reason = await codeOff(
      with_({
        views: {
          tabs: [{ id: "room", title: "Room" }],
          pages: [{ id: "room", title: "Room page" }],
        },
      }),
    );
    expect(reason).toMatch(/share the id room/);
  });
});

describe("unknown Lucide names", () => {
  it.each([
    [
      "a pane",
      { panes: [{ id: "ci", title: "CI", icon: "lucide:no-such-icon-zz" }] },
      "panes[0].icon",
    ],
    [
      "a tab",
      {
        views: {
          tabs: [{ id: "room", title: "Room", icon: "lucide:no-such-icon-zz" }],
        },
      },
      "views.tabs[0].icon",
    ],
    [
      "a page",
      {
        views: {
          pages: [
            { id: "board", title: "Board", icon: "lucide:no-such-icon-zz" },
          ],
        },
      },
      "views.pages[0].icon",
    ],
  ])(
    "on %s are skipped with a reason and dropped",
    async (_what, patch, field) => {
      const { code, skipped } = await accepted(with_(patch));
      expect(skipped).toContainEqual({
        path: `${LABEL}.${field}`,
        reason: "dx has no Lucide icon named no-such-icon-zz.",
      });
      const items = [
        ...(code.panes ?? []),
        ...(code.views?.tabs ?? []),
        ...(code.views?.pages ?? []),
      ];
      expect(items.some((item) => item.icon === "lucide:no-such-icon-zz")).toBe(
        false,
      );
    },
  );
});

describe("what still reads, and its defaults", () => {
  it("runs jobs in the Worker's module when there is no durable host", async () => {
    const { code } = await accepted(
      with_({ host: "worker", entry: "dev.dxcode/index.js" }),
    );
    expect(code.hosts).toBeUndefined();
    expect(code.entry).toBe("dev.dxcode/index.js");
    expect(code.jobs?.map(({ id }) => id)).toEqual(["check-ci"]);
  });

  it("gives a Thread type chat side by default", async () => {
    const { code } = await accepted(
      with_({
        views: {
          tabs: [{ id: "room", title: "Room" }],
          threadTypes: [{ id: "t", title: "T", view: "room" }],
        },
      }),
    );
    expect(code.views?.threadTypes[0]?.chat).toBe("side");
  });

  it("skips a pane connect host that permissions.network lacks", async () => {
    const { code, skipped } = await accepted(
      with_({
        panes: [
          {
            id: "ci",
            title: "CI",
            connect: { hosts: ["evil.example"], portal: [8411] },
          },
        ],
      }),
    );
    expect(skipped).toContainEqual({
      path: `${LABEL}.panes[0].connect.hosts`,
      reason:
        "evil.example is not in permissions.network; the pane cannot reach it.",
    });
    expect(code.paneConnect).toEqual([
      { pane: "ci", hosts: [], portal: [8411] },
    ]);
  });

  it("reads the skill's Orb host example whole", async () => {
    const { code, skipped } = await accepted({
      apiVersion: 1,
      host: { worker: "dev.dxcode/index.js", orb: "dev.dxcode/orb/main.js" },
      binaries: [{ name: "jq", apt: "jq" }],
      panes: [
        {
          id: "preview",
          title: "Preview",
          icon: "lucide:monitor",
          connect: { portal: [8411] },
        },
      ],
      permissions: { ui: ["pane"], shell: true },
    });
    expect(skipped).toEqual([]);
    expect(code.hosts?.orb).toBe("dev.dxcode/orb/main.js");
    expect(code.panes).toEqual([
      { id: "preview", title: "Preview", icon: "lucide:monitor" },
    ]);
    expect(code.paneConnect).toEqual([
      { pane: "preview", hosts: [], portal: [8411] },
    ]);
  });
});
