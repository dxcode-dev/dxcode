# @dxcode/plugin

Types for dx plugin code. A dx plugin is an [Agent Plugins](https://agent-plugins.org)
package whose `plugin.json` names a JavaScript entry module under
`extensions["dev.dxcode"]`. dx runs that module in an isolated Cloudflare
Dynamic Worker and hands it the `PluginAPI` these types describe. Code can
also run as a process in the Thread's Orb, and a plugin can declare
schedules and listeners that run its code in the background (see the
sections below).

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
  buttons above the composer: `send-message`, `copy`, `open-url`, or
  `run-command`.
- `registerCommand` adds command palette entries in Threads where the plugin
  runs; `registerLinkPattern` links matching transcript text. Neither needs
  a permission.

## Views: screens dx draws from data

A plugin's screen is a JSON file in its package. dx draws it with its own
parts, in light, dark, and on a phone, and runs no plugin code in the
browser. List each view in the manifest's `views`:

```json
"views": [
  { "id": "dashboard", "title": "Log Watch", "icon": "lucide:chart-line",
    "file": "views/dashboard.json", "show": ["page", "panel", "card", "app"] }
]
```

- `show` says where it appears: `page` (a page at `/plugins/<name>/<id>`),
  `panel` (a Thread tab from the Views menu), `card` (under a tool call),
  and `app` (a kind of Thread whose main area it draws, with the chat
  beside it).
- The code sets the view's state with `ctx.views.set(viewId, path, value)`,
  and every open copy updates live. A `call` action runs a function from
  the manifest's `exports` as the person who clicked.
- A tool shows the view as a card with
  `return { ...summary, ...ctx.views.card("dashboard") }`.
- `ctx.threads.create({ prompt, type: "dashboard" })` starts a Thread of an
  `app` view (needs `permissions.threads` `create`, outside any Thread).

[`examples/plugins/log-watch`](../../examples/plugins/log-watch/) is a
complete one.

### Looking like dx in MCP Apps cards

An MCP Apps card from the plugin's MCP server gets dx's theme as the MCP
Apps style variables (`var(--color-text-secondary)`, `var(--font-sans)`,
`var(--border-radius-md)` and the rest). Add
`<script type="module" src="dx:plugin-ui"></script>` to its HTML, and dx
inlines `@dxcode/plugin-ui`: web components in dx's look that follow the
person's palette and light or dark mode.

```html
<script type="module" src="dx:plugin-ui"></script>
<dx-card heading="Release board" description="What ships next.">
  <dx-button slot="actions" size="xs" icon="upload">Ship</dx-button>
</dx-card>
```

The kit has buttons, chips, icons, cards, stats, lists, tables, form fields,
tabs, empty states, and code blocks; the building-plugins skill's
`reference/plugin-ui.md` describes each one.

`import { definePlugin } from "@dxcode/plugin"` also works inside dx: the
host provides the module.

## Calling other plugins

A plugin publishes functions with `dx.expose({ status: async (args, ctx) => … })`
and lists them in the manifest's `exports`. Another plugin that names it in
`permissions.plugins` calls it through dx:

```js
const status = await ctx.plugins.call("incident", "status", { service: "api" });
```

dx checks, in order: the callee is in `permissions.plugins`
(`not-permitted`), the chain does not loop and is at most 3 deep (`cycle`),
the callee is installed and on for the call's owner (`not-installed`), and
its `exports` lists the function (`not-exported`). A refusal rejects with an error named
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

// dev.dxcode/index.js, in a tool's execute:
//   await ctx.host("orb").call("start");
```

- `binaries`: `{ "name": "adb", "apt": "adb" }` installs a Debian package;
  `{ "name": "tool", "url": "https://…", "sha256": "…" }` downloads and checks
  a file (`path` names the file inside a .zip, .tar.gz, .tgz, or .tar.xz); `{ "name": "tool",
  "path": "bin/tool" }` uses a file in the plugin. Each new tool is reviewed.
- The process lives while a call runs, and about a minute after; the Orb
  sleeps on its usual schedule and the process wakes with it.
- `ctx.$` there streams: ``for await (const { stream, text } of ctx.$`adb logcat -d`)``.
  Awaiting it still gives `{ exitCode, stdout, stderr }`; 60 seconds by
  default, up to 5 minutes with `timeoutMs`, keeping the first 1 MiB of each
  stream.
- Plugin secrets stay with the Worker code: `ctx.secrets` is refused in the
  Orb host, where anything with the Thread's rights could read them.

## Icons and archived Threads

`"icon"` in the manifest block sets the plugin's icon: a path, or
`{ "src", "dark", "monochrome", "background" }`. Tools, commands, and views
take their own `icon`: `lucide:<name>`, or an .svg or .png under `assets/`.

`archivedThreads` is `hide` by default; `live` keeps the plugin's code
working in archived Threads, but only at a trusted tier (otherwise it acts
as `hide`). With
`thread.archived` in `events`, a plugin hears once, with no Orb, that its
Thread was archived.

## Schedules, listeners, state, and Threads

These work the same in function code as in a plugin's `service` (a program
on a plugin Orb, called over `DX_API`), so code can move between the two and
keep its state, its Threads, and its identity. A plugin without a `service`
never starts an Orb.

- **Schedules.** `"schedules": [{ "name": "check", "every": "15m" }, { "name": "daily", "cron": "0 9 * * *" }]`
  (`every` 1m to 30d, five-field UTC `cron`). Without a service, each
  occurrence sends the function code `job.run` with `{ name, scheduledAt }`;
  with one, the service gets `POST /jobs/<name>`. A missed occurrence runs
  once. Each run has 5 minutes, as the install's person, with no Thread.
- **Listeners.** `"listeners": [{ "name": "alerts", "url": "wss://alerts.example.com/stream" }]`:
  dx keeps a `wss://` WebSocket or an `https://` server-sent event stream
  open (the host must be in `permissions.network`), reconnects it with a
  backoff, refuses redirects, and sends each message to the function code as
  `listener.event` with `{ name, data }`, one at a time. A listener with
  `run` instead (a command whose output lines are events) needs a service.
- **State.** `ctx.storage` is the install's key-value store, the same one a
  service reads with `/state`: 1,000 keys, 64 KiB of JSON each.
- **Threads.** `ctx.threads.open({ key, title, prompt, projectId })` opens
  a Thread as the install's person (with `key`, the open one comes back
  instead, `created: false`); `ctx.threads.post(threadId, text, { wake })`
  posts a note, or a message the agent answers, into a Thread it opened.
  `open` needs `permissions.threads` `create`; `post` needs `create` or
  `post` (and `post` to wake).
- **Cloud identity.** `ctx.identity.token(audience, ttlSeconds?)` returns an
  OIDC token whose subject names the install, for a cloud that trusts dx.

`ctx.threads.open`, `ctx.threads.post`, and `ctx.identity` exist for a
personal or workspace install, never for a plugin a repository carries.

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
      "ui": ["prompt", "notify", "quick-action"],
      "shell": true,
      "plugins": ["incident"],
      "threads": ["create", "post"]
    },
    "icon": "assets/icon.svg",
    "archivedThreads": "show",
    "settings": [{ "key": "team", "label": "Team", "type": "string", "required": true }],
    "views": [{ "id": "board", "title": "Board", "file": "views/board.json", "show": ["panel"] }],
    "exports": [{ "name": "status", "description": "The open incident, if any." }],
    "schedules": [{ "name": "sync", "every": "5m" }],
    "listeners": [{ "name": "alerts", "url": "wss://api.example.com/alerts" }]
  }
}
```

Every `.js` and `.mjs` file under `dev.dxcode/` is loaded as a module, so
relative imports work; at most 16 modules, 64 KiB each, 512 KiB in all.
Build TypeScript and npm dependencies into JavaScript before packaging.

Licensed under the Apache License, Version 2.0.
