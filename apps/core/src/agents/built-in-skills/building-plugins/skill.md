---
name: building-plugins
description: "Use when the user asks you to build, change, or fix a dx plugin: a custom tool, event hook, webhook, palette command, or bundle of skills and MCP servers they describe. Load FIRST, before writing plugin.json or plugin code. Covers the package format, permissions, every event, webhook triggers, the code API, installing it with manage_dx, and checking it works."
---

# Building dx plugins

A dx plugin is an [Agent Plugins](https://agent-plugins.org) package. It can hold skills, remote MCP servers, and code that dx runs in an isolated Dynamic Worker. Install or update it with the `manage_dx` tool. A new plugin, a workspace plugin, or an update that asks for a new permission waits until the owner applies it on a card above the composer that shows every file and permission; an update to a personal plugin that keeps its permissions applies at once. The plugin loads in new Threads.

## Workflow

1. Ask only what you cannot decide: what the plugin should do, and which secret or API it needs. Choose the names yourself.
2. If it needs a secret, call `manage_dx` with `topic: "secrets"`, `operation: "request"` first. Never ask for the value in chat.
3. Write the files (below) and call `manage_dx` with `topic: "plugins"`, `operation: "create"`, `scope: "personal"` (or `"workspace"` when asked), `name`, `files`, and a one-sentence `reason`. For anything this page does not settle (a type, a limit, an option), read the full reference first: `manage_dx` with `topic: "plugins"`, `operation: "docs"` (add `query`, such as `"registerPane"` or `"trigger"`, for just the matching parts), or this skill's `reference/README.md` and `reference/plugin-api.ts.txt` (the `@dxcode/plugin` types).
4. Check that it works (see [Verify after install](#verify-after-install)), then tell the owner how to use it.
5. To change it later: `operation: "read"` returns its files as dx stores them. Edit those, keep the `name`, raise `version`, and call `operation: "update"` with every file. With the same permissions it applies at once and the result shows the diff; with new ones the card shows the diff and what it adds.

## Files

```
plugin.json
dev.dxcode/index.js        # code: optional
skills/<name>/SKILL.md     # skills: optional
mcp.json                   # remote MCP servers: optional
```

`plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
  "name": "release-notes",
  "displayName": "Release Notes",
  "version": "1.0.0",
  "description": "Drafts release notes from merged pull requests.",
  "extensions": {
    "dev.dxcode": {
      "apiVersion": 1,
      "entry": "dev.dxcode/index.js",
      "permissions": {
        "network": ["api.github.com"],
        "secrets": ["GITHUB_TOKEN"]
      }
    }
  }
}
```

- `name`: lowercase letters, digits, `.` and `-`, at most 64 characters. Pick one no installed plugin uses (`manage_dx` plugins list).
- Grant the least the code needs. `permissions` fields:
  - `network`: hostnames `ctx.fetch` may reach over HTTPS, such as `api.openai.com` or `*.example.org`.
  - `secrets`: secret names `ctx.secrets.get` may read. A plugin reads its own scope's secret (personal or workspace) first, then the Thread's Project secret.
  - `ai`: `true` for `ctx.ai.generate`, which uses the owner's model connections with no key: the Thread's model, or one listed in `models`.
  - `models`: models the code may choose, as `provider/model` IDs from Model Routing (`cloudflare/@cf/moonshotai/kimi-k2.6`) or dx modes (`low`, `medium`, `high`, `ultra`).
  - `agents`: `true` for `dx.createAgent(...).run` and agent modes, which run as Threads.
  - `tools`: dx tools `ctx.tools.call` may call.
  - `threads`: a list of `create`, `read`, and `post`. `create` gives `ctx.threads.create({ prompt, projectId, title, type })` in calls that run outside any Thread: a webhook handler (see [Webhooks](#webhooks-triggerreceived)) or a page's `onMessage` (see [Views and plugin calls](#views-and-plugin-calls)). `read` gives `ctx.thread.info()` and `ctx.thread.messages({ limit })` (at most 20, latest first by page), and `ctx.threads.get(id)` for another Thread the owner can open. `post` gives `ctx.thread.note(text)`, shown to everyone with no model call, and `ctx.thread.appendUserMessage(text)`, which the agent answers. Posts show as the plugin's. `agent.start` events carry `event.author`; skip `author.kind === "plugin"` so a plugin never answers its own posts.
  - `shell`: `true` for `ctx.$` and `ctx.exec`, shell commands (git, gh, scripts) in the Thread's Orb, in its checkout. Not in webhook handlers: they have no Thread.
  - `events`: the events the code handles with `dx.on`; dx sends no other. See [Events](#events).
  - `ui`: `prompt`, `notify`, `quick-action`, `pane`.
  - `plugins`: other plugins' names `ctx.plugins.call(plugin, fn, args)` may call; see [Views and plugin calls](#views-and-plugin-calls).
  - `wake`: `true` for `ctx.wake(threadId, message)`, which posts a message that starts the Thread's agent, from a job or watch (trusted tiers; see [Background jobs](#background-jobs-storage-and-watches)).
- `tier` (optional, beside `permissions`): the highest trust tier the plugin asks for: `sandboxed`, `personal-dev`, `workspace-trusted`, or `verified`. dx grants the lower of this and what the install earns: repository plugins are `sandboxed`, or `workspace-trusted` when an admin trusts the repository; personal installs are `personal-dev` in their owner's Threads and `sandboxed` elsewhere; workspace installs are `workspace-trusted` (`verified` when signed by a key the workspace trusts). A workspace admin sets the highest tier, trusted repositories, and trusted signing keys in the workspace Plugins settings, under Plugin trust. An unknown value counts as `sandboxed`. Code reads its tier as `ctx.tier`; a feature its tier doesn't allow is absent, not an error, and the Plugins page marks it "Needs workspace trust".
- Panes and views run in the viewer's browser, so a personal install's panes, tabs, and Thread types run `sandboxed` for anyone but its owner: no streams, Portal, or views for them.
- In a shared Thread, a personal install's commands, run-command quick actions, and pane messages are the owner's only: others don't see them, their pane shows "Only <owner> can use this plugin here", and a direct call gets 403 `PLUGIN_UI_OWNER_ONLY`. A workspace install takes them from every member. `ctx.caller.userId` is always the person who clicked, and the audit records them.
- Registering tools and palette commands needs no permission.
- The entry must be JavaScript (`.js` or `.mjs`) under `dev.dxcode/`; a `.ts` file is refused. Write TypeScript against `@dxcode/plugin` if you like, then ship the compiled `.js`. Every `.js`/`.mjs` there is a module, so relative imports work. At most 16 modules, 64 KiB each. No npm packages: use `fetch` and the APIs below.

## Code

```js
/** @param {import("@dxcode/plugin").PluginAPI} dx */
export default function (dx) {
  dx.registerTool({
    name: "release_notes",
    description: "Drafts release notes for a repository's merged pull requests. Use when asked for release notes.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "owner/name" } },
      required: ["repo"],
    },
    async execute(input, ctx) {
      const token = await ctx.secrets.get("GITHUB_TOKEN");
      if (token === undefined) return "GITHUB_TOKEN is not set. Ask the owner to add it.";
      const response = await ctx.fetch(`https://api.github.com/repos/${input.repo}/pulls?state=closed`, {
        headers: { authorization: `Bearer ${token}`, "user-agent": "dx-plugin" },
      });
      if (!response.ok) return `GitHub answered ${response.status}.`;
      const pulls = await response.json();
      return pulls.slice(0, 20).map((pull) => `- ${pull.title}`).join("\n");
    },
  });
}
```

- A tool's `name` is what the agent calls: lowercase letters, digits, and `_`, at most 48 characters, not a name another tool has. Its `description` tells the agent when to use it.
- `execute` returns a string, or JSON-able data. Each call has the tier's time: 60 seconds sandboxed, 5 minutes at a trusted tier (see `tier` above). Throwing reports the error to the agent; prefer returning a plain message for expected failures such as a missing secret or a non-2xx response.
- `ctx.fetch(url, { method, headers, body })` takes a string `body`; send JSON with `JSON.stringify` and a `content-type` header. Only hosts in `network` are reachable.
- `` await ctx.$`git log -1 --format=%s -- ${path}` `` resolves `{ exitCode, stdout, stderr, timedOut, truncated }`, also when the command fails, so check `exitCode`. Each interpolated value is one quoted word; never build a command line from model or user text with `ctx.exec`. `ctx.$.with({ cwd, timeoutMs })` sets a folder inside the checkout or a limit (30 s by default, at most 60 s and the call's own limit). Other plugins' `tool.call` handlers may reject the command.
- `ctx.storage` keeps small values per install; `ctx.log.info(message, data)` writes to the plugin's log.
- Code split across hosts: when the manifest's `host` is an object naming an entry module per host (`{ "worker": "index.js", "durable": "live.js" }`), each module calls `dx.expose({ name: async (args, ctx) => result })` while it starts, and another host calls it with `ctx.host("durable").call("name", args)`. Arguments and results are JSON; a host cannot call itself, and dx refuses a host the manifest does not name or the install's trust tier does not allow.
- Other registrations: `dx.on(event, handler)`, `dx.expose(...)` and `dx.registerJob(...)` (see [Background jobs](#background-jobs-storage-and-watches)), `dx.registerCommand({ id, title, run })`, `dx.registerLinkPattern({ pattern, url })`, `dx.registerPane(...)`, `dx.registerView(...)`; and `ctx.ui.confirm` / `input` / `select` / `notify` with the `ui` grants.
- Native tools, long-running work, or a local server: add an `orb` entry (`"host": { "worker": "dev.dxcode/index.js", "orb": "dev.dxcode/orb/main.js" }`). It needs `permissions.shell`: it runs as a Node process in the Thread's Orb with the Thread's files, environment, and secrets whatever `secrets` grants (the install review says so), Node's modules, and the manifest's `binaries` on its PATH: `{ "name": "adb", "apt": "adb" }`, `{ "name", "url", "sha256" }` for a checked download (`path` names the file inside a .zip, .tar.gz, .tgz, or .tar.xz), or `{ "name", "path" }` for a file in the plugin; the Worker calls it with `ctx.host("orb").call(...)`. There `ctx.$` streams (``for await (const { stream, text } of ctx.$`cmd`)``, 60 s by default, up to 5 minutes). A pane shows a port it serves with `window.dx.portal(port, element)` once the port is listed in the manifest pane's `connect.portal`. The process stops about a minute after its last call or connection. Plugin secrets stay with the Worker code; `ctx.secrets` is refused there. Trusted tiers only; read [The Orb host](#the-orb-host-a-worked-example) below before writing one.
- Live panes (trusted tiers): a manifest pane (`"panes": [{ "id", "title", "connect": { … } }]`) may list `connect.hosts` (each in `network`) the frame may fetch and open WebSockets to, up to 4 `portal` ports, and `webrtc: true`. Such a registered pane gets `window.dx.stream()`, fed by `ctx.ui.stream(paneId)` (a binary channel, 5 MB/s, 10 MB/s verified; its `url` lets an Orb or container process produce it), `window.dx.rtc()` for TURN servers, and `window.dx.portal(port, element, { path })`. Tabs and pages get none of these.
- Build a pane's `html` from the dx UI kit so it looks like dx in light and dark: put `<script type="module" src="dx:plugin-ui"></script>` in it and use `<dx-button>`, `<dx-card>`, `<dx-stat>`, `<dx-list>`/`<dx-list-item>`, `<dx-table>` (`.columns`, `.rows`), `<dx-input>`/`<dx-select>`/`<dx-textarea>`/`<dx-checkbox>`/`<dx-switch>` in a `<form>`, `<dx-tabs>`/`<dx-tab>`, `<dx-chip tone>`, `<dx-empty>`, `<dx-code>` and `<dx-player>`. Read `reference/plugin-ui.md` for their attributes before you write one. The kit's `icon` attributes take only the 49 names its Icons section lists (`refresh-cw`, `circle-check`, `git-pull-request`, …); any other name draws nothing. The manifest's and `registerPane`'s `icon` is different: any Lucide name as `lucide:<name>`. For your own CSS, use dx's theme variables, such as `var(--color-text-secondary)`, `var(--color-border-tertiary)` and `var(--font-sans)`, never fixed colors.

## The Orb host: a worked example

A pane that shows a local web server the plugin starts in the Thread's Orb. The manifest names both hosts, grants `shell`, and lets the pane frame the port:

```json
"dev.dxcode": {
  "apiVersion": 1,
  "host": { "worker": "dev.dxcode/index.js", "orb": "dev.dxcode/orb/main.js" },
  "binaries": [{ "name": "jq", "apt": "jq" }],
  "panes": [{ "id": "preview", "title": "Preview", "icon": "lucide:monitor", "connect": { "portal": [8411] } }],
  "permissions": { "ui": ["pane"], "shell": true }
}
```

```js
// dev.dxcode/orb/main.js: a Node process in the Orb.
import { createServer } from "node:http";
let server;
export default (dx) => dx.expose({
  async start() {
    server ??= createServer((_req, res) => res.end("<h1>Hello from the Orb</h1>")).listen(8411, "127.0.0.1");
    return { port: 8411 };
  },
});
```

```js
// dev.dxcode/index.js: the Worker starts it when the pane asks, and the pane draws the port.
const HTML = `<!doctype html><script type="module" src="dx:plugin-ui"></script>
<dx-card heading="Preview" flush><div id="screen" style="height: 480px"></div></dx-card>
<script type="module">
  // Ask the Worker to start the server (a dx/plugin.post request), then frame its port.
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.id !== "start") return;
    if (event.data.error) document.getElementById("screen").textContent = event.data.error.message;
    else window.dx.portal(8411, document.getElementById("screen"));
  });
  parent.postMessage({ jsonrpc: "2.0", id: "start", method: "dx/plugin.post", params: { message: { action: "start" } } }, "*");
</script>`;
export default (dx) => dx.registerPane({
  id: "preview",
  title: "Preview",
  html: HTML,
  onMessage: (message, ctx) => message.action === "start" ? ctx.host("orb").call("start") : null,
});
```

`window.dx` exists only in a manifest pane with `connect`, at a trusted tier, for a viewer at that tier too. Below it, `ctx.host("orb")` is refused: check `ctx.tier` and say so in the pane.

## Views and plugin calls

At the trusted tier (a personal install in the owner's own Threads, a workspace install, or a plugin from a trusted repository), a plugin can draw tabs, full pages, and Thread types. Below that tier dx leaves them out; a personal install's views show only to its owner. Draw each with `dx.registerView({ id, html, onMessage })`, an MCP Apps view like a pane, and declare where it shows under the manifest's `views`:

- `tabs: [{ id, title, icon?, archivedThreads? }]`: a full-width Thread tab, opened from the Views menu. `ctx.panes.get(id).post(message)` updates it live. `icon` is `lucide:<name>` or an asset path.
- `pages: [{ id, title, icon?, path }]`: a full page at `/plugins/<name>/<id><path>`, outside any Thread. Its view first hears `{ type: "dx.page", path }`. Its `onMessage` has no `ctx.thread`, and with `threads: ["create"]` may call `ctx.threads.create({ prompt, title, type })` with one of the plugin's own Thread types.
- `threadTypes: [{ id, title, icon?, view, chat }]`: `view` names one of its tabs, which draws the Thread's main area. `chat` is `side` or `hidden`. People pick the type in New Thread → Options → Thread type, or from the palette ("New …"). A Thread keeps its type, and opens as a plain chat if the plugin is off.

To let other plugins call it, a plugin lists `exports: [{ name, description }]` and publishes them with `dx.expose({ name: async (args, ctx) => … })`. A caller lists the callee under `permissions.plugins` and calls `await ctx.plugins.call("incident", "status", args)`. A refusal rejects with an error named `PluginCallRefused`, whose `code` is `not-permitted`, `cycle` (a loop, or more than 3 deep), `not-installed`, `not-exported`, `lower-tier` (the caller's tier is lower than the callee's), or `owner-only` (another member's click on a workspace plugin's command or pane, reaching the owner's personal plugin). The callee runs with its own grants and secrets, sees `ctx.calledBy.plugin`, and spends the caller's remaining time. Repository plugins neither call nor are called.

## Icon and archived Threads

Give every plugin an icon in `extensions["dev.dxcode"]`; dx shows it on the Plugins page, pane tabs, prompts, quick actions, palette rows, link chips, notices, agent modes, tool rows, and the tag on messages the plugin posts. Without one, dx draws a letter tile and the install review warns; catalogs need one.

```json
"icon": { "src": "assets/icon.svg", "dark": "assets/icon-dark.svg", "monochrome": "assets/icon-mono.svg", "background": "#0F766E" }
```

- SVG is best (dx rebuilds it from a safe allowlist); a PNG must be square and at least 128×128. Each file is at most 64 KB. `assets/icon.svg` or `assets/icon.png` alone still works as `src`.
- On dark themes dx uses `dark`, else `monochrome` (an SVG drawn in the text color with `currentColor`), else `src` on the `background` tile.
- Items take their own `icon`: `lucide:<name>` (such as `lucide:smartphone`) or a `.svg`/`.png` under `assets/`. Set it on `registerCommand`, `registerTool`, or `registerPane`, or in a manifest `panes` entry: `"panes": [{ "id": "devices", "title": "Devices", "icon": "assets/phone.svg", "archivedThreads": "show" }]`.

`archivedThreads` says what the plugin shows in archived Threads, for the whole plugin or per pane:

- `"hide"` (default): nothing; its code never runs for the Thread.
- `"show"`: panes show read-only, drawn from the last `ctx.panes.get(id).snapshot(state)`; the view hears that state once as a `dx/plugin.message`. Prompts, quick actions, commands, and link patterns stay hidden.
- `"live"`: panes stay interactive, and the plugin's durable host keeps running its jobs and watches for the Thread. A `live` on one pane or tab is enough to keep the jobs running; without any, they pause until the Thread is restored. Needs a trusted tier and a durable host (`jobs` or `host.durable`); otherwise dx serves it as `"hide"`. Posts, wakes, prompts, agents, and Orb commands stay off: an archived Thread never wakes.

Save a snapshot whenever the pane's state changes, or in a `thread.archived` handler. A Thread tab saves its own with `ctx.panes.get(tabId).snapshot(state)`; it needs no `pane` grant.

## Events

`dx.on(event, handler)` runs `handler(event, ctx)` for each event the manifest lists in `permissions.events`. Each handler has 10 seconds (`trigger.received` 25, `changes.prompt` 8 shared by all plugins); several run in order (workspace installs, then personal, then repository plugins, then by name).

| Event | When | Payload (`event`) | Handler may return |
| --- | --- | --- | --- |
| `session.start` | Once per Thread, before the agent first works in it | `{ threadId }` | nothing |
| `agent.start` | The agent starts on a delivered message | `{ threadId, message, author? }`; `author.kind` is `person`, `plugin`, `thread`, or `automation` | `{ context }`: a note the model reads before answering |
| `agent.end` | The agent answered and called no more tools | `{ threadId, toolCalls: [{ tool, isError }], continuations }` | `{ action: "continue", message }` keeps it going, at most 5 times in a row |
| `tool.call` | Before a tool call runs | `{ threadId, tool, callId, input, plugin? }`; `plugin` is set for another plugin's `ctx.$` | see below |
| `tool.result` | A tool call finished | `{ threadId, tool, callId, input, status: "done" \| "error", output?, error? }` | `{ action: "modify", output }` replaces the result |
| `trigger.received` | A webhook delivery to one of the plugin's triggers | `{ trigger: { id }, data, eventId, deliveryId, idempotencyKey, attempt }` | nothing; throwing fails the delivery |
| `job.run` | A declared job runs that the code did not register with `dx.registerJob` (durable host) | `{ id, runId, data }` | nothing |
| `changes.prompt` | The Changes pane builds its ship prompt | `{ threadId, action, baseBranch?, prompt }` | `{ prompt }` replaces it (at most 10,000 characters, 8 s for all plugins) |
| `thread.archived` | The Thread was archived: the agent stopped and waiting prompts were cancelled. Once, no Orb | `{ threadId }` | nothing; clean up, such as stopping a device or saving a pane's `snapshot` |
| `thread.unarchived` | The Thread was restored. Once, no Orb | `{ threadId }` | nothing |

`tool.call` decides whether a call runs. Return nothing or `{ action: "allow" }` to let it run; `{ action: "reject-and-continue", message }` to skip it and tell the agent why; `{ action: "modify", input }` to run it with a new input; `{ action: "synthesize", output }` to skip it and return `output` as its result. The first handler that does not allow wins, and a handler that throws or times out rejects the call. Tool names are what the model sees: `shell_command`, `edit_file`, `create_file`, and so on (`Bash`, `Edit`, `Write` in Claude Code mode), so match both when it matters.

In Claude Code mode, Claude Code's own tools (`Bash`, `Edit`, `Write`, …) reach `tool.call` and `tool.result` through Claude Code's hooks, with two differences. A `synthesize` cannot hand Claude a result for a call Claude Code did not run: the call is denied and Claude reads `output` as the reason. `tool.result` sees `Bash`'s output as text (stdout, then stderr), as `shell_command`'s; a `modify` becomes the text Claude reads as stdout.

```js
// Turns a force push into --force-with-lease, which refuses to overwrite
// commits it has not seen. -f, --force, and +branch all force a push.
dx.on("tool.call", (event) => {
  if (event.tool !== "shell_command" && event.tool !== "Bash") return;
  const command = String(event.input.command ?? "");
  if (!/\bgit\s+push\b/.test(command) || command.includes("--force-with-lease")) return;
  const forced = /\s(?:-f|--force)(?=\s|$)|\s\+\S/.test(command);
  if (!forced) return;
  const safer = command.replace(/\s(?:-f|--force)(?=\s|$)/g, " --force-with-lease");
  return /\s\+\S/.test(safer)
    ? { action: "reject-and-continue", message: "Force pushes with +branch are blocked; use --force-with-lease." }
    : { action: "modify", input: { ...event.input, command: safer } };
});
```

A pattern check like this catches mistakes, not someone set on getting around it: a command can reach the same effect another way (a script, an alias, `bash -c`). Never present such a hook as a security boundary.

## Background jobs, storage, and watches

Trusted tiers (your own personal install in your Threads, or a workspace install) get a long-lived **durable host**: one Durable Object per install, or per install and Thread with `"durableScope": "thread"`. It keeps the plugin's SQLite, files, jobs, and open connections. Sandboxed plugins (repository plugins, other people's Threads) don't get it: `ctx.sql`, `ctx.blobs`, `ctx.jobs`, `ctx.watch`, and `ctx.wake` are absent, so check for them.

```json
"dev.dxcode": {
  "apiVersion": 1,
  "host": { "worker": "dev.dxcode/index.js", "durable": "dev.dxcode/live.js" },
  "durableScope": "thread",
  "jobs": [{ "id": "check-ci", "title": "Check CI", "schedule": { "at": "on-demand" } }],
  "permissions": { "network": ["api.github.com"], "ui": ["pane"], "wake": true }
}
```

- `jobs` declares every job, shown at install and on the plugin's row in Settings → Plugins with its next run and a Stop button. `schedule` is `{ "every": "5m" }` (1m to 30d), `{ "cron": "0 * * * *" }` (UTC), or `{ "at": "on-demand" }`. `every` and `cron` jobs start by themselves; on-demand ones run when the code schedules them.
- `dx.registerJob({ id, run(data, ctx) })` runs a job in the durable host (from `host.durable`, or the Worker's module when there is none). Each run has 5 minutes.
- `ctx.jobs.schedule(id, when, data)` schedules a declared job, or one instance of it as `<id>:<key>` (such as `check-ci:pr-12`) with its own `data`. `when` is `{ every: "5m" }`, `{ cron: "0 * * * *" }`, or `{ at: Date.now() + 60_000 }` (`at` is an epoch millisecond, not the manifest's `"on-demand"`, which throws); leave it out (`ctx.jobs.schedule("check-ci")`, or `ctx.jobs.schedule("check-ci:pr-12", undefined, { pr: 12 })`) to run an on-demand job now or keep a repeating job's declared schedule; `ctx.jobs.cancel(id)`, `ctx.jobs.list()`. A tier allows 20 scheduled jobs (verified: 50); past that, `schedule` throws.
- `ctx.sql.exec(sql, ...params)` runs SQL on the install's own SQLite (`{ rows, changes }`, about 1 GB). Tables named `_dx_`, `_cf_`, or `sqlite_`, and `PRAGMA`/`ATTACH`, are refused.
- `ctx.blobs.put(key, body, { contentType })`, `get`, `delete`, `list(prefix)` keep files in R2 (25 MiB each, 5 GB per install, 20 GB verified).
- `ctx.watch(url, handler)` (durable host only, inside a job or exposed function) keeps a `wss://` WebSocket or `https://` server-sent event stream open on a `network` host and calls `handler(message, ctx)` per message. dx reconnects it, and runs the job again if the handler is lost, so open watches inside jobs. It returns `{ close() }`; await `close()` inside the call.
- `dx.expose({ name(args, ctx) {…} })` names functions another host of the plugin calls with `ctx.host("durable").call("name", args)`, such as a command that checks something now in the durable host.
- Calling a public API from a job or watch: dx's servers share addresses, so APIs that rate-limit anonymous callers by address refuse them. GitHub's REST API answers 403 without a token, so a GitHub watcher must declare `"secrets": ["GITHUB_TOKEN"]` and send `authorization: Bearer <token>` from `ctx.secrets.get("GITHUB_TOKEN")`; tell the owner to add that secret if it's missing.
- `ctx.wake(threadId, message)` needs `permissions.wake`: at most 6 wakes a Thread an hour, never into an archived Thread.
- In a thread-scoped object, `ctx.thread` and `ctx.panes` are the Thread's, so a job can update a pane live: `await ctx.panes.get("ci").post(state)`. The pane receives each post as it happens; it never needs to poll.
- Archiving a Thread pauses its jobs and closes its watches; restoring it resumes both (a `live` plugin keeps them running).
- A Durable Object's SQL is checked against the quota on every statement: a write that would cross it is rolled back with an error.
- Uninstalling the plugin, or deleting the Thread or workspace, deletes its durable storage, SQL, and blobs for good.

## Webhooks (`trigger.received`)

A webhook lets another service start work in dx: a deploy finished, a form was filled in, an alert fired. The handler runs before any Thread exists, as the person who created the trigger, so `ctx` has no `thread`, `ui`, or `$`; it starts Threads with `ctx.threads.create`.

`plugin.json` permissions: `"events": ["trigger.received"]` and `"threads": ["create"]`, plus any `network` and `secrets` the handler itself uses.

```js
/** @param {import("@dxcode/plugin").PluginAPI} dx */
export default function (dx) {
  dx.on("trigger.received", async (event, ctx) => {
    const data = /** @type {{ service?: string, status?: string, url?: string }} */ (event.data ?? {});
    if (typeof data.service !== "string") return; // not a payload this handles
    await ctx.threads.create({
      title: `Deploy ${data.status ?? "update"}: ${data.service ?? "unknown"}`,
      prompt: `A deploy webhook arrived.\n\nService: ${data.service}\nStatus: ${data.status}\nLogs: ${data.url}\n\nSummarize what happened and what to check next.`,
    });
  });
}
```

- `ctx.threads.create({ prompt, title?, projectId? })` starts at most five Threads per delivery, in the trigger owner's account; without `projectId` the Thread has no Project.
- Validate `event.data` yourself: it is whatever the sender posted. Never put its text into a shell command.
- Each delivery runs once: a handler that throws, or runs past 25 seconds, fails it for good, with no retry. Keep the handler short (start a Thread for the real work), and catch errors you can recover from. dx already drops a repeated event ID or idempotency key, so the handler needs no dedupe of its own.

The person connects it, since the URL is a credential: after install, Settings → Triggers → Create trigger, pick the plugin, choose a Signing secret (one of their secrets) or None, and copy the webhook URL. Tell them these steps; you cannot create the trigger. A sender then posts:

```
POST <webhook URL>
content-type: application/json
x-dx-timestamp: <unix seconds or milliseconds, within 5 minutes of now>
x-dx-event-id: <the sender's event ID: letters, digits, . _ : -, at most 128>
x-dx-idempotency-key: <the same kind of ID; a repeat is accepted once>
x-dx-signature: sha256=<hex>      # only when the trigger has a signing secret

{"event": "trigger.received", "data": { ... }}
```

- The body is JSON with exactly `event` and `data`, at most 64 KiB; at most 60 events a minute per trigger.
- The signature is HMAC-SHA256, keyed with the secret's value, over `<timestamp>.<event id>.<idempotency key>.` followed by the raw body, as lowercase hex. A trigger with a signing secret refuses an unsigned or wrongly signed request (403).
- To test without the sender, give the person this to run with their URL, and `SECRET` set to the signing secret's value (leave it empty for a trigger with None):

```sh
TS=$(date +%s); ID="test-$TS"
BODY='{"event":"trigger.received","data":{"service":"api","status":"succeeded","url":"https://example.com/logs/1"}}'
SIG=$([ -n "$SECRET" ] && printf '%s' "$TS.$ID.$ID.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -H "x-dx-timestamp: $TS" -H "x-dx-event-id: $ID" -H "x-dx-idempotency-key: $ID" \
  ${SIG:+-H "x-dx-signature: sha256=$SIG"} -d "$BODY"
```

Each delivery and its status shows under the trigger in Settings → Triggers.

## Native tools in a container (`host.container`)

When plugin code needs a native program (ffmpeg, ImageMagick, pdftotext) and no Orb is there, as for a webhook, give it a container module. dx runs it in a Cloudflare container, one per install, started on demand and stopped after a minute idle. It needs workspace trust: a workspace install, a trusted repository's plugin, or a personal install in its owner's own work; the install review shows "needs workspace trust". A sandboxed install's call is refused and logged.

```jsonc
"host": { "worker": "dev.dxcode/index.js", "container": "dev.dxcode/container/main.js" },
"binaries": [{ "name": "ffmpeg", "apt": "ffmpeg" }]
```

```js
// dev.dxcode/container/main.js: Node.js, with child_process and the file system.
export default (dx) => dx.expose({
  async transcode(args, ctx) { /* run ffmpeg, return JSON */ },
});
// dev.dxcode/index.js: the Worker side calls it.
const result = await ctx.host("container").call("transcode", { seconds: 3 });
```

- Baked-in `apt` packages: ffmpeg, imagemagick, poppler-utils, qpdf, libimage-exiftool-perl, jq, sqlite3, zip, unzip, xz-utils, git, python3, nodejs. Any other tool is a `url` with its `sha256` (an executable, or a .zip/.tar archive with `path` naming the file inside); dx downloads and checks it. `path` alone (a file in the plugin) is Orb-only.
- The container has no internet. Its `ctx` reaches dx and your granted `network` hosts the same way the Worker's does (`ctx.fetch`, `ctx.storage`, `ctx.threads`, `ctx.secrets`).
- Limits: 5 minutes a call, 2 calls at once, 8 MB of arguments or result, and an hour of call time a day (ten a month) per install; cold starts and idle minutes don't count, but all container time stops at three times that. A workspace's plugins share 8 hours of container time a day, and a deployment runs at most 50 containers at once. A call over any cap is refused with the reason ("try again shortly" when the deployment is full). A webhook delivery that calls a container gets the container's time limit, not 25 seconds.
- Cost: about $0.03 an hour of container time (1/4 vCPU, 1 GiB), charged to the installer's workspace. The plugin's details on the Plugins page show "Host usage this month": time, calls, and cost per Durable Object, Orb, and container host.

## Calling a model API with a key

For an OpenAI-compatible chat API (OpenAI, OpenRouter, Groq, Together, Workers AI), grant its host and the key's secret, and send:

```js
const response = await ctx.fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: input.prompt }] }),
});
const data = await response.json();
return data.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 2000);
```

Workers AI's OpenAI-compatible endpoint is `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1/chat/completions`; put the account ID in a plugin setting or ask for it.

## Agents and models

- `ctx.ai.generate({ prompt, system, maxTokens, model, reasoningEffort })` answers with text; `model` must be in `models`. A `claude-code/...` model is refused: a Claude plan serves only Claude Code.
- `dx.createAgent({ name, description, instructions, model, reasoningEffort, tools, display })` defines an agent while the plugin starts. It runs as a dx Thread: `instructions` join dx's prompt, `model` (in `models`) is the Thread's model, and `tools` is `"all"`, a list of tool names, or `{ include, exclude }` (a trailing `*` matches a prefix). List dx and Claude Code names both (`edit_file` and `Edit`) to cover both modes.
- `agent.run(message, { timeoutMs })`, inside a tool, command, handler, or pane message, starts a child Thread running the agent and resolves `{ threadId, text }` once it answers. The calling tool's time limit pauses while it waits. A Thread another Thread started as an agent cannot start more agent Threads.
- `dx.registerAgentMode({ key, agent: agent.definition })` lists the agent as a mode people and the main agent (`create_thread` with `agent_mode: "plugin:<plugin>/<key>"`) start Threads in. Declare each key beside `permissions`: `"agentModes": [{ "key": "reviewer", "label": "Reviewer", "description": "…", "color": "#7c3aed" }]`.
- `manage_dx` `plugins docs` with `query: "createAgent"` returns the full agent types.

## Skills and MCP servers in a plugin

- `skills/<name>/SKILL.md`: frontmatter `name` (kebab-case, matching the folder) and `description`, then Markdown instructions. See the building-skills skill.
- `mcp.json`: `{ "mcpServers": { "<name>": { "url": "https://…/mcp" } } }`. A server needing sign-in is signed into from Settings after install.

## Settings

Values the owner sets after install go in `"settings": [{ "key": "account", "label": "Account ID", "type": "string", "required": true }]` beside `permissions`; code reads them with `await ctx.settings.get()`. Never put a secret in a setting: use `secrets`.

## Verify after install

A plugin loads in new Threads, so check it before you report it done:

1. `manage_dx` `plugins list` shows it `enabled`, with the permissions you meant.
2. For tools, commands, and events, start a new Thread with `create_thread` (no Project unless the plugin needs one) whose prompt exercises it, such as "Call check_site_status on https://example.com and show the raw result.", and read its answer with `wait_for_threads`. A tool missing from that Thread, or one that fails, means the install or the code is wrong: read the error, fix the files, and `update`.
3. For a webhook, the person creates the trigger and runs the `curl` above; then Settings → Triggers shows the delivery as Delivered and the Thread it started appears in their list. Failed shows only a short reason; the handler's own error is in the plugin's log (`ctx.log`), so log what the handler is about to do.
4. Tell the owner what you checked and how to use it.

### Hot reload while you build a personal plugin

Code and settings changes reach the owner's Threads, this one included, on the plugin's next call; no new Thread is needed.

- Once a personal plugin is installed from a ZIP, the owner turns on **Hot reload** in its settings on the Plugins page. Only they can.
- Turning it on binds it to one of the owner's active Threads; only that Thread's Orb may reload, and a reload from another Thread is refused (`other-thread`). A reloaded version still applies in all the owner's Threads. Hot reload turns itself off after 24 hours unused.
- Then, in that Thread, `dxd plugin dev <folder>` sends the folder (with `plugin.json` at its top) and dx updates that install; `dxd plugin dev <folder> --watch` sends it again on every save. Run `--watch` under `setsid nohup … &` so it outlives the command.
- dx applies only a version that asks for nothing new. A new permission, host, job, or a higher `tier` is refused (`widens`); update it with `manage_dx` or on the Plugins page, where the owner reviews it.
- Each tier has its own limits: sandboxed code gets 60 s a call and 60 pane posts a minute; personal-dev and workspace-trusted get 5 minutes and 600.
