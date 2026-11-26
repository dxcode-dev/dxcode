---
name: building-plugins
description: "Use when the user asks you to build, change, or fix a dx plugin: a custom tool, event hook, webhook, palette command, or bundle of skills and MCP servers they describe. Load FIRST, before writing plugin.json or plugin code. Covers the package format, permissions, every event, webhook triggers, the code API, trying it in this Thread as a draft (dxd plugin load, logs, reload), and keeping it with manage_dx."
---

# Building dx plugins

A dx plugin is an [Agent Plugins](https://agent-plugins.org) package. It can hold skills, remote MCP servers, and code that dx runs in an isolated Dynamic Worker. Build and try it in this Thread first as a draft (`dxd plugin load <folder>`): its tools reach you from your next tool call, with no card. Keep it with the `manage_dx` tool. A new plugin, a workspace plugin, or an update that asks for a new permission waits until the owner applies it on a card above the composer that shows every file and permission; an update to a personal plugin that keeps its permissions applies at once. Once applied, the plugin works in this Thread from your next tool call and in other Threads from their next message; its skills load in new Threads.

## Workflow

1. Ask only what you cannot decide: what the plugin should do, and which secret or API it needs. Choose the names yourself.
2. If it needs a secret, call `manage_dx` with `topic: "secrets"`, `operation: "request"` first. Never ask for the value in chat.
3. Write the files (below) in a folder in the Orb, such as `~/plugins/release-notes/`. For anything this page does not settle (a type, a limit, an option), read the full reference first: `manage_dx` with `topic: "plugins"`, `operation: "docs"` (add `query`, such as `"registerPane"` or `"trigger"`, for just the matching parts), or this skill's `reference/README.md` and `reference/plugin-api.ts.txt` (the `@dxcode/plugin` types).
4. Load it as a draft, call its tools, read its log, fix, and reload until it does the job (see [Try it as a draft](#try-it-as-a-draft)).
5. Keep it: call `manage_dx` with `topic: "plugins"`, `operation: "create"`, `scope: "personal"` (or `"workspace"` when asked), `name`, `files` (every file in the folder), and a one-sentence `reason`. When the owner applies the card, the kept plugin replaces the draft in this Thread from your next tool call. Call its tool once more to check, then tell the owner how to use it.
6. To change it later: `operation: "read"` returns its files as dx stores them. Edit those, keep the `name`, raise `version`, and call `operation: "update"` with every file. With the same permissions it applies at once and the result shows the diff; with new ones the card shows the diff and what it adds.

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
  - `threads`: a list of `create`, `read`, and `post`. `create` gives `ctx.threads.create({ prompt, projectId, title, type })` in calls that run outside any Thread: a webhook handler (see [Webhooks](#webhooks-triggerreceived)). `type` names one of the plugin's views whose `show` includes `app`. `read` gives `ctx.thread.info()` and `ctx.thread.messages({ limit })` (at most 20, latest first by page), and `ctx.threads.get(id)` for another Thread the owner can open. `post` gives `ctx.thread.note(text)`, shown to everyone with no model call, and `ctx.thread.appendUserMessage(text)`, which the agent answers. Posts show as the plugin's. `agent.start` events carry `event.author`; skip `author.kind === "plugin"` so a plugin never answers its own posts. For a personal or workspace install, `create` also gives `ctx.threads.open({ key, prompt, title, projectId })` from any call (see [Schedules, listeners, state, and Threads](#schedules-listeners-state-and-threads)).
  - `shell`: `true` for `ctx.$` and `ctx.exec`, shell commands (git, gh, scripts) in the Thread's Orb, in its checkout. Not in webhook handlers: they have no Thread.
  - `events`: the events the code handles with `dx.on`; dx sends no other. See [Events](#events).
  - `ui`: `prompt`, `notify`, `quick-action`.
  - `plugins`: other plugins' names `ctx.plugins.call(plugin, fn, args)` may call; see [plugin calls](#thread-types-and-plugin-calls).
- `schedules` and `listeners` (beside `permissions`): background runs of the code, with no Thread and no Orb; see [Schedules, listeners, state, and Threads](#schedules-listeners-state-and-threads).
- `tier`, `jobs`, `durableScope`, `host.durable`, `host.container`, and `permissions.wake` are gone: a plugin that names one does not load and must be rebuilt.
- In a shared Thread, anyone who can write in it uses its plugins as the owner does, personal and draft ones included: tools, hooks, commands, quick actions, and view buttons. `ctx.caller.userId` and the audit name the person who acted. View-only members cannot send messages or act.
- Registering tools and palette commands needs no permission.
- An installed plugin's entry runs inside dx and must be JavaScript (`.js` or `.mjs`) under `dev.dxcode/`. Every `.js`/`.mjs` there is a module, so relative imports work. At most 16 modules, 64 KiB each. No npm packages: use `fetch` and the APIs below.
- TypeScript (`.ts`, `.mts`) runs wherever the code runs under Node in the Orb: a draft's entry, and an installed plugin's `host.orb` entry. Node strips the types, so use only erasable syntax (no `enum` or `namespace`) and write imports with the `.ts` extension (`import { x } from "./util.ts"`). To keep a draft whose entry is TypeScript, either bundle it to `dev.dxcode/index.js` first (`npx esbuild dev.dxcode/index.ts --bundle --format=esm --outfile=dev.dxcode/index.js`, then point `entry` at it) or move the code to a `host.orb` entry behind a small JavaScript `entry`.

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
- `execute` returns a string, or JSON-able data. Each call has 5 minutes (60 seconds for a plugin a repository carries). Throwing reports the error to the agent; prefer returning a plain message for expected failures such as a missing secret or a non-2xx response.
- `ctx.fetch(url, { method, headers, body })` takes a string `body`; send JSON with `JSON.stringify` and a `content-type` header. Only hosts in `network` are reachable.
- `` await ctx.$`git log -1 --format=%s -- ${path}` `` resolves `{ exitCode, stdout, stderr, timedOut, truncated }`, also when the command fails, so check `exitCode`. Each interpolated value is one quoted word; never build a command line from model or user text with `ctx.exec`. `ctx.$.with({ cwd, timeoutMs })` sets a folder inside the checkout or a limit (30 s by default, at most 60 s and the call's own limit). Other plugins' `tool.call` handlers may reject the command.
- `ctx.storage` keeps small values per install; `ctx.log.info(message, data)` writes to the plugin's log.
- Code split across hosts: when the manifest's `host` is an object naming an entry module per host (`{ "worker": "index.js", "orb": "orb/main.js" }`), each module calls `dx.expose({ name: async (args, ctx) => result })` while it starts, and another host calls it with `ctx.host("orb").call("name", args)`. Arguments and results are JSON; a host cannot call itself, and dx refuses a host the manifest does not name.
- Other registrations: `dx.on(event, handler)`, `dx.expose(...)`, `dx.registerCommand({ id, title, run })`, `dx.registerLinkPattern({ pattern, url })`; and `ctx.ui.confirm` / `input` / `select` / `notify` with the `ui` grants.
- Native tools, long-running work, or a local server: add an `orb` entry (`"host": { "worker": "dev.dxcode/index.js", "orb": "dev.dxcode/orb/main.js" }`). It needs `permissions.shell`: it runs as a Node process in the Thread's Orb with the Thread's files, environment, and secrets whatever `secrets` grants (the install review says so), Node's modules, and the manifest's `binaries` on its PATH: `{ "name": "adb", "apt": "adb" }`, `{ "name", "url", "sha256" }` for a checked download (`path` names the file inside a .zip, .tar.gz, .tgz, or .tar.xz), or `{ "name", "path" }` for a file in the plugin; the Worker calls it with `ctx.host("orb").call(...)`. There `ctx.$` streams (``for await (const { stream, text } of ctx.$`cmd`)``, 60 s by default, up to 5 minutes). The process stops about a minute after its last call. Plugin secrets stay with the Worker code; `ctx.secrets` is refused there. Read [The Orb host](#the-orb-host-a-worked-example) below before writing one.
- Build an MCP Apps card's HTML (from the plugin's MCP server) from the dx UI kit so it looks like dx in light and dark: put `<script type="module" src="dx:plugin-ui"></script>` in it and use `<dx-button>`, `<dx-card>`, `<dx-stat>`, `<dx-list>`/`<dx-list-item>`, `<dx-table>` (`.columns`, `.rows`), `<dx-input>`/`<dx-select>`/`<dx-textarea>`/`<dx-checkbox>`/`<dx-switch>` in a `<form>`, `<dx-tabs>`/`<dx-tab>`, `<dx-chip tone>`, `<dx-empty>`, `<dx-code>` and `<dx-player>`. Read `reference/plugin-ui.md` for their attributes before you write one. For a select with search or rich options, a menu, a dialog, a popover, a tooltip or a date picker, write UI SDK's `ui-*` tags in the same page (`<ui-select>`, `<ui-menu>`, `<ui-dialog>`, `<ui-date-picker>`, …): dx inlines them styled like the kit, with no extra tag. `reference/plugin-ui.md` shows their markup and events. The kit's `icon` attributes take only the 49 names its Icons section lists (`refresh-cw`, `circle-check`, `git-pull-request`, …); any other name draws nothing. The manifest's `icon` is different: any Lucide name as `lucide:<name>`. For your own CSS, use dx's theme variables, such as `var(--color-text-secondary)`, `var(--color-border-tertiary)` and `var(--font-sans)`, never fixed colors.

## The Orb host: a worked example

A tool that runs `jq` in the Thread's Orb. The manifest names both hosts and grants `shell`:

```json
"dev.dxcode": {
  "apiVersion": 1,
  "host": { "worker": "dev.dxcode/index.js", "orb": "dev.dxcode/orb/main.js" },
  "binaries": [{ "name": "jq", "apt": "jq" }],
  "permissions": { "shell": true }
}
```

```js
// dev.dxcode/orb/main.js: a Node process in the Orb.
import { execFileSync } from "node:child_process";
export default (dx) => dx.expose({
  pretty: ({ text }) => execFileSync("jq", ["."], { input: text, encoding: "utf8" }),
});
```

```js
// dev.dxcode/index.js: the Worker's tool calls the Orb process.
export default (dx) => dx.registerTool({
  name: "pretty_json",
  description: "Formats JSON with jq.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: ({ text }, ctx) => ctx.host("orb").call("pretty", { text }),
});
```


## Programs that keep running: a service

Pick the lowest place that works. Function code (`entry`, JavaScript inside dx) fits a call to an API, a webhook, or a policy: it costs no Orb time and wakes in milliseconds. A **service** fits work that needs files, a binary or CLI, a long run, or a process that keeps a connection or a tail open, such as `tail -F` on a log or `gcloud` every 15 minutes. A service runs on a plugin Orb, in any language, and costs Orb time while awake; it sleeps after 5 idle minutes unless `keepRunning`. A plugin with no `service` never starts an Orb.

```json
"dev.dxcode": {
  "apiVersion": 1,
  "service": { "run": "node service.mjs", "setup": "npm ci", "orb": "shared", "keepRunning": false,
               "tools": [{ "name": "log_counts", "description": "Error counts", "input": { "type": "object" } }] },
  "schedules": [{ "name": "check", "every": "15m" }],
  "listeners": [{ "name": "errors", "run": "tail -F /var/log/app.log" }],
  "permissions": { "threads": ["create", "post"], "secrets": ["LOG_SOURCE_TOKEN"] }
}
```

- `schedules` take `every` (such as `15m`) or `cron` (`0 9 * * *`, UTC). A listener is a command whose every output line is one event.
- dx calls the program on `$PORT` (127.0.0.1): `POST /jobs/<schedule>` `{ scheduledAt }`, `POST /tools/<name>` `{ input, threadId, userId }` → `{ output }`, `POST /events/<listener>` `{ line, at }` (one per line), and `POST /calls/<fn>` `{ args }` → `{ value }`.
- The program calls dx at `$DX_API` with `Authorization: Bearer $DX_TOKEN`: `GET`/`PUT`/`DELETE /state/<key>` (`{ value }`, at most 64 KiB and 1,000 keys), `GET /settings`, `POST /views/<id>/state` `{ path, value }`, `POST /threads` `{ key, title, prompt, projectId? }` → `{ threadId, url, created }` (the same `key` while that Thread is open returns it: one Thread per incident), `POST /threads/<id>/messages` `{ text, wake }`, and `POST /id-token` `{ audience }` (or `dxd id-token --audience X`). In Node, `import { serviceClient } from "@dxcode/plugin/service"` wraps these.
- Granted secrets arrive as environment variables of the same name. The program's output is the plugin's log.
- Where it runs: Settings → Orb Providers → Plugins, or the plugin's "Runs on". With none chosen, the plugin says so. The person who installed it pays for its Orb time on a dx-billed account; on their own provider key dx charges nothing.
- A draft does not run its service yet: keep the plugin to try one. `examples/plugins/log-watch` shows a whole plugin.

## Screens: views described as data

A plugin's screen is a JSON file that dx draws with its own parts, so it matches dx in light, dark, and on a phone. Prefer it to HTML. `examples/plugins/log-watch` shows a whole one.

1. Declare each view in `extensions["dev.dxcode"].views`, a list of at most 8: `{ "id": "dashboard", "title": "Log Watch", "file": "views/dashboard.json", "show": ["page", "panel", "card"], "icon": "lucide:chart-line" }`. Places: `page` opens at `/plugins/<plugin name>/<id>`; `panel` is in a Thread's Views menu, beside Files and Changes; `card` shows in a message; `app` fills a Thread's main area with the chat beside it.
2. Write the file: `{ "title": "…", "state": { …initial state }, "parts": [ … ] }`. Parts:
   - `heading`, `text`, `code`, `badge`: `text` or `bind` (a badge's `tones` maps a value to neutral, info, success, warning, or danger).
   - `stat`: `label`, `bind`, `format` (number, percent, bytes, duration in ms, money in USD, time), `change` (a path to a number), `rising` (`"bad"` when a rise is bad news).
   - `table`: `bind` (a list of objects), `columns: [{ key, label, format?, tones?, secondary? }]`, `rowKey`, `rowAction`.
   - `list`: `bind`, `primary`, `secondary`, `meta`, `badge`, `tones`, `itemAction`.
   - `chart`: `kind` (`line` or `bar`), `label`, `bind`, `x` (the x axis field), `series: [{ key, label }]`.
   - `log`: `bind` (strings, or `{ text, time, level }`).
   - `form`: `id`, `fields: [{ type: input|select|switch|textarea, name, label, options?, bind? }]`, `submit: { label, action }`.
   - `button`: `label`, `action`, `variant`. `tabs`: `tabs: [{ label, parts }]`. `empty`: `title`, `description`.
   - Any part takes `when` or `unless` (a path): it shows only while that value is, or is not, empty. Paths are dot keys and list indexes: `stats.errors`, `rows.0.status`.
3. Actions: `{ "type": "start_thread", "prompt": "Investigate {{latest.message}}" }`; `open_thread` (`thread`); `call` (`fn`, listed in the manifest's `exports` and published with `dx.expose`, plus `args`, `result`: where its reply goes in state, and `confirm`); `open_link` (`url`; another site asks first); `copy` (`text`). Templates read `{{path}}` from state, `{{row.field}}` in a table or list, and `{{form.name}}` in a form.
4. Keep the state current from code: `await ctx.views.set("dashboard", "stats.errors", 12)` (the path `""` replaces the whole state), and `await ctx.views.get("dashboard", "rows")`. A tool shows a view as a card under its call by returning, or spreading into its result, `ctx.views.card("dashboard")`: `return { ...summary, ...ctx.views.card("dashboard") }`. It works from any handler, tool, webhook trigger, or exposed function, and every open browser updates at once. A view's state is at most 512 KB: keep tables to the rows people look at.
5. dx checks each view file at install. A broken file is left out, and the install's skipped list names the part and field, such as `parts[0] (table "recent"): columns[0].key is missing.` Fix the file and install again.

State is drawn as text, never HTML. In a Thread shared with others, a personal plugin's buttons work only for its owner. A `call` runs as the person who clicked (`ctx.caller.userId`).

## Thread types and plugin calls

A view described as data with `show: ["app"]` is the only kind of Thread type: it draws a Thread's main area with the chat beside it. People pick it when they start a Thread, and code starts one with `ctx.threads.create({ prompt, title, type: "<plugin>/<view id>" })`.

To let other plugins call it, a plugin lists `exports: [{ name, description }]` and publishes them with `dx.expose({ name: async (args, ctx) => … })`. A caller lists the callee under `permissions.plugins` and calls `await ctx.plugins.call("incident", "status", args)`. A refusal rejects with an error named `PluginCallRefused`, whose `code` is `not-permitted`, `cycle` (a loop, or more than 3 deep), `not-installed`, or `not-exported`. The callee runs with its own grants and secrets, sees `ctx.calledBy.plugin`, and spends the caller's remaining time. Repository plugins neither call nor are called.

## Icon and archived Threads

Give every plugin an icon in `extensions["dev.dxcode"]`; dx shows it on the Plugins page, view tabs, prompts, quick actions, palette rows, link chips, notices, agent modes, tool rows, and the tag on messages the plugin posts. Without one, dx draws a letter tile and the install review warns; catalogs need one.

```json
"icon": { "src": "assets/icon.svg", "dark": "assets/icon-dark.svg", "monochrome": "assets/icon-mono.svg", "background": "#0F766E" }
```

- SVG is best (dx rebuilds it from a safe allowlist); a PNG must be square and at least 128×128. Each file is at most 64 KB. `assets/icon.svg` or `assets/icon.png` alone still works as `src`.
- On dark themes dx uses `dark`, else `monochrome` (an SVG drawn in the text color with `currentColor`), else `src` on the `background` tile.
- Items take their own `icon`: `lucide:<name>` (such as `lucide:smartphone`) or a `.svg`/`.png` under `assets/`. Set it on `registerCommand`, `registerTool`, or a `views` entry.

`archivedThreads` says what the plugin shows in archived Threads:

- `"hide"` (default): nothing; its code never runs for the Thread.
- `"show"`: prompts, quick actions, commands, and link patterns stay hidden.
- `"live"`: the plugin keeps working for the archived Thread. Posts, prompts, agents, and Orb commands stay off: an archived Thread never wakes.

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
| `job.run` | A manifest schedule is due, for a plugin with no `service`. No Thread, 5 minutes | `{ name, scheduledAt }` | nothing |
| `listener.event` | A message arrived on a manifest listener's `url`. No Thread, one at a time | `{ name, data }` | nothing |
| `changes.prompt` | The Changes pane builds its ship prompt | `{ threadId, action, baseBranch?, prompt }` | `{ prompt }` replaces it (at most 10,000 characters, 8 s for all plugins) |
| `thread.archived` | The Thread was archived: the agent stopped and waiting prompts were cancelled. Once, no Orb | `{ threadId }` | nothing; clean up, such as stopping a device |
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

## Schedules, listeners, state, and Threads

A plugin's background work runs its function code inside dx, with no Orb and no Thread, as the install's person (a workspace install's installer). The same contract reaches a `service` (a program on a plugin Orb) over `DX_API`, so code can move to a service and keep its state, its Threads, and its identity. A plugin with no `service` never starts an Orb.

```json
"dev.dxcode": {
  "apiVersion": 1,
  "entry": "dev.dxcode/index.js",
  "schedules": [{ "name": "check-ci", "every": "5m" }],
  "listeners": [{ "name": "deploys", "url": "wss://events.example.com/deploys" }],
  "permissions": { "network": ["api.github.com", "events.example.com"], "secrets": ["GITHUB_TOKEN"], "threads": ["create", "post"] }
}
```

```js
dx.on("job.run", async ({ name, scheduledAt }, ctx) => {
  const failing = await failingChecks(ctx);
  if (failing.length === 0) return;
  const { threadId, created } = await ctx.threads.open({ key: "ci-red", title: "CI is red", prompt: `These checks fail: ${failing.join(", ")}. Find out why.` });
  if (!created) await ctx.threads.post(threadId, `Still failing at ${scheduledAt}.`);
});
dx.on("listener.event", async ({ name, data }, ctx) => {
  await ctx.storage.set("last-deploy", data);
});
```

- `schedules`: `every` (1m to 30d) or five-field UTC `cron`. Each occurrence sends `job.run`; a missed one runs once. Each run has 5 minutes. Declaring schedules grants the event: no need to list `job.run` in `events`.
- `listeners` with `url`: dx keeps a `wss://` WebSocket or `https://` server-sent event stream open on a host `permissions.network` lists, refuses redirects, reconnects with a backoff, and sends each message as `listener.event` (JSON when it parses), one at a time, at most 100 waiting. A listener with `run` (a command) needs a `service`.
- `ctx.storage` is the install's state: the store a service reads with `/state`.
- `ctx.threads.open({ key, prompt, title, projectId })` opens a Thread as the install's person; with `key`, the Thread already open for it comes back (`created: false`), so a repeated alert opens one Thread. At most 20 new Threads an hour. `ctx.threads.post(threadId, text, { wake })` adds a note to a Thread it opened, or with `wake: true` and the `post` grant, a message the agent answers.
- `ctx.identity.token(audience, ttlSeconds)` returns an OIDC token whose subject names the install, for a cloud that trusts dx (see the using-workload-identity skill).
- These three exist for a personal or workspace install, never for a plugin a repository carries.
- Calling a public API from a schedule or listener: dx's servers share addresses, so APIs that rate-limit anonymous callers by address refuse them. GitHub's REST API answers 403 without a token, so a GitHub watcher must declare `"secrets": ["GITHUB_TOKEN"]` and send `authorization: Bearer <token>` from `ctx.secrets.get("GITHUB_TOKEN")`; tell the owner to add that secret if it's missing.
- Turning the plugin off stops its schedules and closes its listeners; turning it on starts them again within a minute.

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
- `agent.run(message, { timeoutMs })`, inside a tool, command, or handler, starts a child Thread running the agent and resolves `{ threadId, text }` once it answers. The calling tool's time limit pauses while it waits. A Thread another Thread started as an agent cannot start more agent Threads.
- `dx.registerAgentMode({ key, agent: agent.definition })` lists the agent as a mode people and the main agent (`create_thread` with `agent_mode: "plugin:<plugin>/<key>"`) start Threads in. Declare each key beside `permissions`: `"agentModes": [{ "key": "reviewer", "label": "Reviewer", "description": "…", "color": "#7c3aed" }]`.
- `manage_dx` `plugins docs` with `query: "createAgent"` returns the full agent types.

## Skills and MCP servers in a plugin

- `skills/<name>/SKILL.md`: frontmatter `name` (kebab-case, matching the folder) and `description`, then Markdown instructions. See the building-skills skill.
- `mcp.json`: `{ "mcpServers": { "<name>": { "url": "https://…/mcp" } } }`. A server needing sign-in is signed into from Settings after install.

## Settings

Values the owner sets after install go in `"settings": [{ "key": "account", "label": "Account ID", "type": "string", "required": true }]` beside `permissions`; code reads them with `await ctx.settings.get()`. Never put a secret in a setting: use `secrets`.

## Try it as a draft

A draft is a plugin folder loaded into this Thread only. It runs in this Thread's Orb with the powers the Orb already has, needs no card, and no other Thread sees it.

```sh
dxd plugin load ~/plugins/release-notes   # loaded release-notes (draft, this Thread): 1 tool: release_notes
dxd plugin logs release-notes             # what its code printed, and why it stopped
dxd plugin reload release-notes           # after an edit; prints what loaded
dxd plugin unload release-notes
dxd plugin list
```

- Its tools are yours from your next tool call: call `release_notes` directly, as a tool, the way you call `shell_command`. It is not a module, so code you run cannot import or call it. In Claude Code, a tool loaded during this turn may be missing from your tool list until Claude Code refreshes it; call it through `plugin_tool` with `plugin`, `tool`, and `args` meanwhile.
- When a call fails, read the error, then `dxd plugin logs <name>` (add `--follow` to watch). `console.log` and `ctx.log` both land there. Fix the files and `dxd plugin reload <name>`. A reload whose code fails to start keeps the version loaded before and says why.
- The draft's code runs under Node from its folder, so `node_modules` there works and TypeScript loads. Installed, the same `entry` runs inside dx with no Node modules or file system: keep only what the plugin API and `fetch` give it, or move Node-only work to a `host.orb` entry.
- What a draft cannot do: read a secret this Thread's commands do not receive (the load is refused and names the secret; request it with `manage_dx` `secrets request`, then load again), use `ctx.storage` (write a file in its folder), install `binaries` (install them in the Orb yourself), or run schedules, listeners, or a service. It acts in every turn in its Thread, a contributor's too, and loads nowhere the workspace keeps plugins out of Thread Orbs.
- Its `tool.call` handlers run before installed plugins' handlers, so an installed gate still decides last.
- A draft's views (see [Screens](#screens-views-described-as-data)) show as panels in this Thread only, under Views. `dxd plugin load` checks each view file and prints what is wrong in it, such as `note: … parts[0] (stat "Count"): bind is missing.`; `ctx.views.set` from the draft's code moves the panel, and a reload keeps its state.
- A draft whose code is a `host.orb` entry needs `permissions.shell: true`, as installed Orb code does; without it the load is refused.
- People in the Thread see a note each time a draft loads, reloads, or unloads, with what it adds.
- A draft with the same name as an installed plugin replaces it in this Thread, so you can rework an installed plugin as a draft and keep it with `update`.

## Verify after install

Check the kept plugin before you report it done:

1. `manage_dx` `plugins list` shows it `enabled`, with the permissions you meant.
2. Call its tool, command, or event in this Thread once more: the installed version runs now, inside dx, so a call that worked as a draft and fails here means it relied on Node or the Orb. Read the error, fix the files, and `update`.
3. For a webhook, the person creates the trigger and runs the `curl` above; then Settings → Triggers shows the delivery as Delivered and the Thread it started appears in their list. Failed shows only a short reason; the handler's own error is in the plugin's log (`ctx.log`), so log what the handler is about to do.
4. Tell the owner what you checked and how to use it.
