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
  - `threads`: a list of `create`, `read`, and `post`. `create` gives `ctx.threads.create({ prompt, projectId, title })` in a webhook handler only (see [Webhooks](#webhooks-triggerreceived)). `read` gives `ctx.thread.info()` and `ctx.thread.messages({ limit })` (at most 20, latest first by page), and `ctx.threads.get(id)` for another Thread the owner can open. `post` gives `ctx.thread.note(text)`, shown to everyone with no model call, and `ctx.thread.appendUserMessage(text)`, which the agent answers. Posts show as the plugin's. `agent.start` events carry `event.author`; skip `author.kind === "plugin"` so a plugin never answers its own posts.
  - `shell`: `true` for `ctx.$` and `ctx.exec`, shell commands (git, gh, scripts) in the Thread's Orb, in its checkout. Not in webhook handlers: they have no Thread.
  - `events`: the events the code handles with `dx.on`; dx sends no other. See [Events](#events).
  - `ui`: `prompt`, `notify`, `quick-action`, `pane`.
- Registering tools and palette commands needs no permission.
- The entry must be JavaScript (`.js` or `.mjs`) under `dev.dxcode/`; TypeScript is refused. Every `.js`/`.mjs` there is a module, so relative imports work. At most 16 modules, 64 KiB each. No npm packages: use `fetch` and the APIs below.

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
- `execute` returns a string, or JSON-able data. Each call has 60 seconds. Throwing reports the error to the agent; prefer returning a plain message for expected failures such as a missing secret or a non-2xx response.
- `ctx.fetch(url, { method, headers, body })` takes a string `body`; send JSON with `JSON.stringify` and a `content-type` header. Only hosts in `network` are reachable.
- `` await ctx.$`git log -1 --format=%s -- ${path}` `` resolves `{ exitCode, stdout, stderr, timedOut, truncated }`, also when the command fails, so check `exitCode`. Each interpolated value is one quoted word; never build a command line from model or user text with `ctx.exec`. `ctx.$.with({ cwd, timeoutMs })` sets a folder inside the checkout or a limit (30 s by default, at most 60 s and the call's own limit). Other plugins' `tool.call` handlers may reject the command.
- `ctx.storage` keeps small values per install; `ctx.log.info(message, data)` writes to the plugin's log.
- Other registrations: `dx.on(event, handler)`, `dx.registerCommand({ id, title, run })`, `dx.registerLinkPattern({ pattern, url })`, `dx.registerPane(...)`; and `ctx.ui.confirm` / `input` / `select` / `notify` with the `ui` grants.

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
| `changes.prompt` | The Changes pane builds its ship prompt | `{ threadId, action, baseBranch?, prompt }` | `{ prompt }` replaces it (at most 10,000 characters, 8 s for all plugins) |

`tool.call` decides whether a call runs. Return nothing or `{ action: "allow" }` to let it run; `{ action: "reject-and-continue", message }` to skip it and tell the agent why; `{ action: "modify", input }` to run it with a new input; `{ action: "synthesize", output }` to skip it and return `output` as its result. The first handler that does not allow wins, and a handler that throws or times out rejects the call. Tool names are what the model sees: `shell_command`, `edit_file`, `create_file`, and so on (`Bash`, `Edit`, `Write` in Claude Code mode), so match both when it matters.

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
- `agent.run(message, { timeoutMs })`, inside a tool, command, handler, or pane message, starts a child Thread running the agent and resolves `{ threadId, text }` once it answers. The calling tool's time limit pauses while it waits. A Thread another Thread started as an agent cannot start more agent Threads.
- `dx.registerAgentMode({ key, agent: agent.definition })` lists the agent as a mode people and the main agent (`create_thread` with `agent_mode: "plugin:<plugin>/<key>"`) start Threads in. Declare each key beside `permissions`: `"agentModes": [{ "key": "reviewer", "label": "Reviewer", "description": "…", "color": "#7c3aed" }]`.
- See `examples/plugins/reviewer` in the dx repository.

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
