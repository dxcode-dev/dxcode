# @dxcode/plugin

Types for dx plugin code. A dx plugin is an [Agent Plugins](https://agent-plugins.org)
package whose `plugin.json` names a JavaScript entry module under
`extensions["dev.dxcode"]`. dx runs that module in an isolated Cloudflare
Dynamic Worker and hands it the `PluginAPI` these types describe. At a
trusted tier, code can also run in a Durable Object, the Thread's Orb, or a
container (see the host sections below).

```js
/** @param {import("@dxcode/plugin").PluginAPI} dx */
export default function (dx) {
  dx.on("tool.call", (event) => {
    if (event.tool === "shell_command" && /push\s+--force/.test(String(event.input.command)))
      return { action: "reject-and-continue", message: "Force pushes are blocked." };
  });
  dx.registerTool({
    name: "release_notes",
    description: "Drafts release notes from a list of changes.",
    inputSchema: { type: "object", properties: { changes: { type: "string" } }, required: ["changes"] },
    execute: (input, ctx) => ctx.ai.generate({ prompt: `Release notes for:\n${input.changes}` }),
  });
}
```

## Asking a person, and other Thread UI

With `permissions.ui`, plugin code can draw dx's own UI in the Thread. dx
draws it from plain data, so no plugin HTML runs.

```js
export default function (dx) {
  dx.on("tool.call", async (event, ctx) => {
    if (event.tool !== "shell_command" || !/push\s+--force/.test(String(event.input.command))) return;
    // Shows above the composer; the handler's 10 seconds stop while it waits.
    const ok = await ctx.ui.confirm({ title: "Force push?", message: String(event.input.command), destructive: true });
    if (ok === null) return { action: "reject-and-continue", message: "Nobody answered, so the force push did not run." };
    return ok ? { action: "allow" } : { action: "reject-and-continue", message: "The person declined the force push." };
  });
  dx.registerCommand({
    id: "pick-env",
    title: "Pick a deploy target",
    run: async (ctx) => {
      const env = await ctx.ui.select({
        title: "Deploy to",
        options: [{ value: "staging", label: "Staging" }, { value: "prod", label: "Production" }],
      });
      if (env !== null) await ctx.ui.notify(`Deploying to ${env}`, { level: "success" });
    },
  });
  dx.registerLinkPattern({ pattern: /\bACME-(\d+)\b/, url: "https://acme.example/issues/$1" });
  dx.on("session.start", (_event, ctx) =>
    ctx.thread.createQuickAction?.({ label: "Run checks", action: "send-message", args: { text: "Run the checks." } }));
}
```

- `ctx.ui.confirm`, `input`, and `select` (`ui: ["prompt"]`) show one at a
  time above the composer to the owner and Contribute members, and resolve
  `null` when nobody answers within `timeoutSeconds` (300 by default, at most
  1,800). `input({ secret: true })` takes only the owner's answer.
- `ctx.ui.notify` (`ui: ["notify"]`) shows a toast.
- `ctx.thread.createQuickAction` (`ui: ["quick-action"]`) adds up to 5
  buttons above the composer: `send-message`, `copy`, `open-url`,
  `run-command`, or `open-pane`.
- `registerCommand` adds command palette entries in Threads where the plugin
  runs; `registerLinkPattern` links matching transcript text. Neither needs
  a permission.

## Panes: your own views in a Thread

With `ui: ["pane"]`, a plugin adds its own views to Threads as panes, tabs
beside the transcript. A pane's `html` is an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
view. dx runs it in a sandboxed frame with no network, cookies, or dx API,
and it talks to dx in MCP Apps JSON-RPC over `postMessage`. At a trusted
tier a pane may connect to more; see [Pane streams, network, and
Portal](#pane-streams-network-and-portal).

```js
import BOARD_HTML from "./board.html.js"; // export default "<!doctype html>…"

export default function (dx) {
  dx.registerPane({
    id: "board",
    title: "Release board",
    html: BOARD_HTML,
    // A view's `dx/plugin.post` request; the result answers it.
    onMessage: async (message, ctx) => {
      if (message.action === "ship") await ctx.panes.get("board").post({ shipping: true });
      return { ok: true };
    },
  });
  dx.on("tool.result", async (event, ctx) => {
    const board = ctx.panes.get("board");
    await board.open(); // opens the tab for everyone looking at the Thread
    await board.post({ tool: event.tool, status: event.status }); // live
  });
}
```

In the view, after `ui/initialize` and `ui/notifications/initialized`, each
`post(message)` arrives as a `dx/plugin.message` notification with
`{ message }`. A pane opened later first hears the last 20 posts. People can
open a pane from the Thread's Views menu, or an `open-pane` quick action.

### Looking like dx

Add `<script type="module" src="dx:plugin-ui"></script>` to the view, and dx
inlines `@dxcode/plugin-ui`: web components in dx's look that follow the
person's palette and light or dark mode.

```html
<script type="module" src="dx:plugin-ui"></script>
<dx-card heading="Release board" description="What ships next.">
  <dx-button slot="actions" size="xs" icon="upload">Ship</dx-button>
  <dx-list plain>
    <dx-list-item heading="Unit tests" description="2,184 passed" icon="circle-check">
      <dx-chip slot="trailing" tone="success">Passed</dx-chip>
    </dx-list-item>
  </dx-list>
</dx-card>
```

The kit has buttons, chips, icons, cards, stats, lists, tables, form fields,
tabs, empty states, code blocks and a media player; the building-plugins
skill's `reference/plugin-ui.md` describes each one. Without the tag, the
page stays plain HTML. It still gets dx's theme as the MCP Apps style
variables (`var(--color-text-secondary)`, `var(--font-sans)`,
`var(--border-radius-md)` and the rest).

`import { definePlugin } from "@dxcode/plugin"` also works inside dx: the
host provides the module.

## Tabs, pages, and Thread types

A plugin at the trusted tier (a personal install in its owner's Threads, a
workspace install, or a plugin from a repository an admin trusts) can draw
more than panes. Below that tier dx leaves these out rather than refusing
the plugin. A personal install's tabs and Thread types show only to its
owner: anyone else views it at the sandboxed tier. Each view is `dx.registerView({ id, html, onMessage? })`,
an MCP Apps view framed exactly as a pane is, and the manifest's `views`
says where it shows:

```json
"views": {
  "tabs": [{ "id": "room", "title": "Incident room", "icon": "lucide:siren" }],
  "pages": [{ "id": "board", "title": "Incidents", "path": "/open" }],
  "threadTypes": [{ "id": "room", "title": "Incident room", "view": "room", "chat": "side" }]
}
```

- A **tab** is a full-width Thread tab beside Chat, Files, Changes, and
  Terminal, opened from the Views menu. `ctx.panes.get(tabId).post(message)`
  updates open copies live, as for a pane. `archivedThreads` says whether
  it stays in an archived Thread (see [Icons and archived
  Threads](#icons-and-archived-threads)).
- A **page** is a full page outside any Thread, at
  `/plugins/<name>/<id><path>`, for dashboards and editors. Its view first
  hears `{ type: "dx.page", path }`. Its `onMessage` has no `ctx.thread`;
  with `permissions.threads` `create` it may start Threads, also of its own
  types: `ctx.threads.create({ prompt, title, type: "room" })`.
- A **Thread type** names one of the plugin's tabs, which draws a Thread's
  main area with the chat beside it (`chat: "side"`) or behind its tab
  (`"hidden"`). It is chosen when the Thread starts (New Thread → Options →
  Thread type) and never changes. If the plugin is later off, removed, or
  below the trusted tier for the person looking, the Thread opens as a plain
  chat with a notice.

## Calling other plugins

A plugin publishes functions with `dx.expose({ status: async (args, ctx) => … })`
and lists them in the manifest's `exports`. Another plugin that names it in
`permissions.plugins` calls it through dx:

```js
const status = await ctx.plugins.call("incident", "status", { service: "api" });
```

dx checks, in order: the callee is in `permissions.plugins`
(`not-permitted`), the chain does not loop and is at most 3 deep (`cycle`),
the callee is installed and on for the call's owner (`not-installed`), its
`exports` lists the function (`not-exported`), and the caller's tier is at
least the callee's (`lower-tier`). A personal plugin answers only its
owner's own clicks: a call that another member's click on a workspace
plugin's command, quick action, or pane started is refused (`owner-only`). A refusal rejects with an error named
`PluginCallRefused` with that `code`. The callee runs with its own
permissions, settings, and secrets, never the caller's, and learns who
called it from `ctx.calledBy.plugin`. Its time counts against the caller's
own limit. Repository plugins neither call nor are called. dx audits every
call, allowed or refused.

## Commands in the Thread's Orb

With `"shell": true`, `ctx.$` runs shell commands in the Thread's Orb, in its
checkout:

```js
dx.registerTool({
  name: "pr_checks",
  description: "The pull request's CI checks.",
  inputSchema: { type: "object", properties: { pr: { type: "string" } }, required: ["pr"] },
  async execute({ pr }, ctx) {
    const { exitCode, stdout, stderr } = await ctx.$.with({ timeoutMs: 20_000 })`gh pr checks ${pr} --json name,state`;
    return exitCode === 0 ? JSON.parse(stdout) : `gh failed: ${stderr}`;
  },
});
```

- It resolves `{ exitCode, stdout, stderr, timedOut, truncated }`, also when
  the command exits non-zero. Each interpolated value is one quoted word.
- 30 seconds by default, at most 60 and within the call's own limit; the
  first 128 KB of stdout and of stderr; 32 commands per call, 4 at once.
- Other plugins' `tool.call` handlers see it as `shell_command` with
  `plugin` set, and may block it. dx audits every command.
- Webhook handlers have no `ctx.$`: there is no Thread, so no Orb. Start a
  Thread with `ctx.threads.create` and run the commands there.

## The Orb host: native tools and local servers

With `"host": { "worker": "dev.dxcode/index.js", "orb": "dev.dxcode/orb/main.js" }`,
the `orb` module runs as a Node process that dx starts in the Thread's own
Orb, with the Thread's files, environment, and secrets there, whatever
`secrets` grants; so it needs `"shell": true`, and the review says so. It has Node's modules and the
manifest's `binaries` on its PATH, and it registers what the other host
calls:

```js
// dev.dxcode/orb/main.js
import { definePlugin } from "@dxcode/plugin";
import { createServer } from "node:http";

export default definePlugin((dx) => {
  dx.expose({
    async start() {
      createServer((request, response) => response.end("hello")).listen(8411, "127.0.0.1");
      return { port: 8411 };
    },
  });
});

// dev.dxcode/index.js, in a pane's onMessage:
//   await ctx.host("orb").call("start");
```

- `binaries`: `{ "name": "adb", "apt": "adb" }` installs a Debian package;
  `{ "name": "tool", "url": "https://…", "sha256": "…" }` downloads and checks
  a file (`path` names the file inside a .zip, .tar.gz, .tgz, or .tar.xz); `{ "name": "tool",
  "path": "bin/tool" }` uses a file in the plugin. Each new tool is reviewed.
- A pane shows a port the process serves through the Thread's Portal: list
  it in `"panes": [{ "id": "device", "title": "Device", "connect": { "portal": [8411] } }]`,
  then call `window.dx.portal(8411, element)` in the pane.
- The process lives while a call runs or a pane holds a connection to one of
  those ports, and about a minute after; the Orb sleeps on its usual
  schedule and the process wakes with it.
- `ctx.$` there streams: ``for await (const { stream, text } of ctx.$`adb logcat -d`)``.
  Awaiting it still gives `{ exitCode, stdout, stderr }`; 60 seconds by
  default, up to 5 minutes with `timeoutMs`, keeping the first 1 MiB of each
  stream.
- Plugin secrets stay with the Worker code: `ctx.secrets` is refused in the
  Orb host, where anything with the Thread's rights could read them.
- Only trusted tiers get the Orb host: a sandboxed install's
  `ctx.host("orb")` call is refused.

## Pane streams, network, and Portal

At a trusted tier (for the person viewing as well as the install), a manifest
pane's `connect` opens it up: `hosts` (each already in `permissions.network`)
for fetch, images, media, and WebSockets; `portal`, up to 4 ports of the
Thread's Portal; and `webrtc: true`. Such a pane gets `window.dx`:

- `window.dx.stream()` reads the pane's own binary channel, which the plugin
  writes with `ctx.ui.stream(paneId)` (5 MB/s, 10 MB/s verified).
- `window.dx.rtc()` returns TURN servers for a WebRTC connection.
- `window.dx.portal(port, element, { path })` draws that Portal port over
  `element` and returns a handle with `close()`.

Only panes registered with `registerPane` get `window.dx`, not tabs or pages.
Below the trusted tier, `connect` is dropped and the pane stays sealed.

## Icons and archived Threads

`"icon"` in the manifest block sets the plugin's icon: a path, or
`{ "src", "dark", "monochrome", "background" }`. Tools, commands, panes,
tabs, pages, and Thread types take their own `icon`: `lucide:<name>`, or an
.svg or .png under `assets/`.

`archivedThreads`, for the whole plugin or per pane or tab, is `hide` by
default; `show` draws panes read-only from their last
`ctx.panes.get(id).snapshot(state)`; `live` keeps them working, but only at a
trusted tier with a durable host (otherwise it acts as `hide`). With
`thread.archived` in `events`, a plugin hears once, with no Orb, that its
Thread was archived.

## Background work: the durable host

At a trusted tier, `jobs` or `"host": { "durable": "dev.dxcode/live.js" }`
gives the install a Durable Object (`"durableScope": "thread"`: one per
Thread). Declare jobs as `"jobs": [{ "id": "sync", "title": "Sync",
"schedule": { "every": "5m" } }]` (`every` 1m to 30d, UTC `cron`, or
`{ "at": "on-demand" }`) and run them with `dx.registerJob({ id, run })`;
each run has 5 minutes. There the context adds `ctx.sql` (about 1 GB of
SQLite), `ctx.blobs` (25 MiB each, 5 GB per install, 20 GB verified),
`ctx.jobs` (`schedule`, `cancel`, `list`; 20 scheduled, 50 verified), and
`ctx.watch(url, handler)` for a `wss://` or server-sent event stream on a
`network` host. With `permissions.wake`, `ctx.wake(threadId, message)`
starts a Thread's agent, at most 6 times a Thread an hour. Below the trusted
tier these are absent.

## The container host

`"host": { "worker": "dev.dxcode/index.js", "container": "dev.dxcode/container/main.js" }`
runs exposed functions in a Cloudflare container per install (1/4 vCPU,
1 GiB), called with `ctx.host("container").call(fn, args)`, for native tools
when there is no Orb, as in a webhook. Trusted tiers only. It has no
internet beyond `ctx.fetch` and no `ctx.$`. `binaries` `apt` entries must be
in its image (ffmpeg, imagemagick, poppler-utils, qpdf,
libimage-exiftool-perl, jq, sqlite3, zip, unzip, xz-utils, git, python3,
nodejs); anything else is a `url` with `sha256`. 5 minutes a call, 2 calls
at once, an hour a day and ten a month per install, billed to the
installer's workspace (about $0.03 an hour).

## Manifest

```json
"extensions": {
  "dev.dxcode": {
    "apiVersion": 1,
    "entry": "dev.dxcode/index.js",
    "host": "worker",
    "permissions": {
      "events": ["tool.call", "tool.result", "agent.start", "agent.end", "session.start"],
      "network": ["api.example.com", "*.example.org"],
      "secrets": ["EXAMPLE_TOKEN"],
      "tools": ["read_web_page"],
      "ai": true,
      "ui": ["prompt", "notify", "quick-action", "pane"],
      "shell": true,
      "plugins": ["incident"],
      "wake": true
    },
    "tier": "workspace-trusted",
    "icon": "assets/icon.svg",
    "archivedThreads": "show",
    "panes": [{ "id": "board", "title": "Board" }],
    "settings": [{ "key": "team", "label": "Team", "type": "string", "required": true }],
    "views": { "tabs": [], "pages": [], "threadTypes": [] },
    "exports": [{ "name": "status", "description": "The open incident, if any." }],
    "jobs": [{ "id": "sync", "title": "Sync", "schedule": { "every": "5m" } }],
    "durableScope": "install"
  }
}
```

Every `.js` and `.mjs` file under `dev.dxcode/` is loaded as a module, so
relative imports work; at most 16 modules, 64 KiB each, 512 KiB in all.
Build TypeScript and npm dependencies into JavaScript before packaging.

Licensed under the Apache License, Version 2.0.
