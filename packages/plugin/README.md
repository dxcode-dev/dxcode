# @dxcode/plugin

Types for dx plugin code. A dx plugin is an [Agent Plugins](https://agent-plugins.org)
package whose `plugin.json` names a JavaScript entry module under
`extensions["dev.dxcode"]`. dx runs that module in an isolated Cloudflare
Dynamic Worker and hands it the `PluginAPI` these types describe.

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
and it talks to dx in MCP Apps JSON-RPC over `postMessage`.

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

`import { definePlugin } from "@dxcode/plugin"` also works inside dx: the
host provides the module.

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
      "shell": true
    },
    "settings": [{ "key": "team", "label": "Team", "type": "string", "required": true }]
  }
}
```

Every `.js` and `.mjs` file under `dev.dxcode/` is loaded as a module, so
relative imports work; at most 16 modules, 64 KiB each, 512 KiB in all.
Build TypeScript and npm dependencies into JavaScript before packaging.

Licensed under the Apache License, Version 2.0.
