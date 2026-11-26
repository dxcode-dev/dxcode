/**
 * The dx plugin API, version 1.
 *
 * A dx plugin is an Agent Plugins package (https://agent-plugins.org) whose
 * `plugin.json` names a JavaScript entry module under
 * `extensions["dev.dxcode"]`:
 *
 * ```json
 * {
 *   "$schema": "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
 *   "name": "com.acme.guard",
 *   "version": "1.0.0",
 *   "extensions": {
 *     "dev.dxcode": {
 *       "apiVersion": 1,
 *       "entry": "dev.dxcode/index.js",
 *       "permissions": { "events": ["tool.call"], "network": ["api.acme.com"] }
 *     }
 *   }
 * }
 * ```
 *
 * The entry module's default export receives a {@link PluginAPI} once per
 * worker start and registers handlers and tools on it:
 *
 * ```js
 * export default function (dx) {
 *   dx.on("tool.call", (event) => {
 *     if (event.tool === "shell_command" && /push\s+--force/.test(String(event.input.command)))
 *       return { action: "reject-and-continue", message: "Force pushes are blocked." };
 *   });
 * }
 * ```
 *
 * Code can also ask a person something above the Thread's composer:
 *
 * ```js
 * dx.on("tool.call", async (event, ctx) => {
 *   if (event.tool !== "shell_command" || !/push\s+--force/.test(String(event.input.command))) return;
 *   const ok = await ctx.ui.confirm({ title: "Force push?", message: String(event.input.command) });
 *   return ok ? { action: "allow" } : { action: "reject-and-continue", message: "The person declined the force push." };
 * });
 * ```
 *
 * With `permissions.shell`, code runs commands in the Thread's Orb, in its
 * checkout:
 *
 * ```js
 * dx.registerTool({
 *   name: "last_commit",
 *   description: "The checkout's last commit subject.",
 *   execute: async (_input, ctx) => (await ctx.$`git log -1 --format=%s`).stdout,
 * });
 * ```
 *
 * With `permissions.threads` `["read", "post"]`, code reads Threads and
 * posts into them as the call's owner, marked as the plugin's:
 *
 * ```js
 * dx.registerCommand({
 *   id: "recap",
 *   title: "Post a recap",
 *   run: async (ctx) => {
 *     const recent = await ctx.thread.messages({ limit: 20, roles: ["assistant"] });
 *     await ctx.thread.note(`Recap: ${recent.length} replies so far.`);
 *   },
 * });
 * ```
 *
 * dx runs the code in an isolated Cloudflare Dynamic Worker with no network,
 * secrets, or storage of its own (and, with `host.orb`, as a process in the
 * Thread's Orb). Everything it may reach comes through the
 * {@link PluginContext} each call receives, and only what `permissions`
 * grants: a capability the plugin did not ask for has no object.
 */

/** The plugin API version this package describes. */
export const PLUGIN_API_VERSION = 1;

// ─── Events ─────────────────────────────────────────────────────────────────

/** Once per Thread, before the agent first starts work in it. */
export interface SessionStartEvent {
  readonly threadId: string;
}

/** The agent starts work on a delivered message. */
export interface AgentStartEvent {
  readonly threadId: string;
  /** The delivered message's text, when it has text. */
  readonly message: string;
  /**
   * Who sent it: a person, a plugin (this one's own posts included), another
   * Thread, or an automation.
   */
  readonly author?: ThreadMessageAuthor;
}

/**
 * What an `agent.start` handler may return: `context` reaches the model as
 * a note ahead of its first answer.
 */
export type AgentStartResult = undefined | { readonly context: string };

/** The agent is about to stop: it answered and called no more tools. */
export interface AgentEndEvent {
  readonly threadId: string;
  /** Every tool call the response made, in order. */
  readonly toolCalls: ReadonlyArray<{
    readonly tool: string;
    readonly isError: boolean;
  }>;
  /**
   * How many times plugins kept this response going in a row. dx stops
   * honouring `continue` after {@link MAX_AGENT_END_CONTINUATIONS}.
   */
  readonly continuations: number;
}

/** At most this many `agent.end` continuations in a row. */
export const MAX_AGENT_END_CONTINUATIONS = 5;

/**
 * What an `agent.end` handler may return: `continue` sends `message` to the
 * agent and the response keeps going.
 */
export type AgentEndResult =
  | undefined
  | { readonly action: "continue"; readonly message: string };

/** A tool call the agent is about to make, before it runs. */
export interface ToolCallEvent {
  readonly threadId: string;
  /** The tool's name as the model sees it, such as `shell_command`. */
  readonly tool: string;
  readonly callId: string;
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * The plugin whose code made the call with `ctx.$` or `ctx.exec`, when
   * the agent did not. Such a call is always `shell_command` and its `input`
   * is `{ command, workdir }`, with `workdir` absolute as the agent's is.
   */
  readonly plugin?: string;
}

/**
 * What a `tool.call` handler may return. Nothing, or `allow`, lets the call
 * run. `reject-and-continue` skips it and tells the agent `message`.
 * `modify` runs it with a new input. `synthesize` skips it and returns
 * `output` as its result. The first handler that does not allow wins.
 *
 * A `tool.call` handler that throws or times out rejects the call.
 */
export type ToolCallResult =
  | undefined
  | { readonly action: "allow" }
  | { readonly action: "reject-and-continue"; readonly message: string }
  | {
      readonly action: "modify";
      readonly input: Readonly<Record<string, unknown>>;
    }
  | { readonly action: "synthesize"; readonly output: unknown };

/** A tool call finished. */
export interface ToolResultEvent {
  readonly threadId: string;
  readonly tool: string;
  readonly callId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly status: "done" | "error";
  /** The result, when the call succeeded. */
  readonly output?: unknown;
  /** The failure message, when it failed. */
  readonly error?: string;
}

/** What a `tool.result` handler may return: `modify` replaces the result. */
export type ToolResultResult =
  | undefined
  | { readonly action: "modify"; readonly output: unknown };

/**
 * A webhook delivery to a trigger someone created for this plugin (Settings
 * → Triggers). It runs before any Thread exists, as the trigger's owner: the
 * handler gets no `ctx.thread`, and starts Threads with `ctx.threads` when
 * the manifest grants `permissions.threads`. A handler that throws fails
 * the delivery.
 */
export interface TriggerReceivedEvent {
  readonly trigger: { readonly id: string };
  /**
   * The delivery's `data`. Senders POST `{ "event": "trigger.received",
   * "data": … }` to the trigger's URL with `x-dx-timestamp`,
   * `x-dx-event-id`, and `x-dx-idempotency-key` headers.
   */
  readonly data: unknown;
  /** The sender's event ID, or one dx assigned. */
  readonly eventId: string;
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
}

/**
 * The Changes pane asks for its main action's prompt: the project's Ship
 * Behavior (`action`) and its prompt. A rewritten prompt is shown to the
 * person, with the plugins that changed it, before they send it as their own
 * message. The handler's context has no model calls, UI, network, secrets,
 * dx tools, or Threads, and every plugin shares one 8-second deadline.
 */
export interface ChangesPromptEvent {
  readonly threadId: string;
  /** The project's Ship Behavior, such as "ship" or "push". */
  readonly action: string;
  /** The branch the work goes to, when dx knows it. */
  readonly baseBranch?: string;
  /** The prompt so far: dx's, or the previous plugin's. */
  readonly prompt: string;
}

/**
 * What a `changes.prompt` handler may return: `prompt` replaces the prompt
 * (at most 10,000 characters). Plugins run in order, each seeing the last
 * one's prompt; a plugin that fails or runs out of time is skipped.
 */
export type ChangesPromptResult = undefined | { readonly prompt: string };

/** Each event's payload, the result its handler may return, and its context. */
export interface PluginEvents {
  readonly "session.start": {
    readonly event: SessionStartEvent;
    readonly result: undefined;
    readonly context: ThreadPluginContext;
  };
  readonly "agent.start": {
    readonly event: AgentStartEvent;
    readonly result: AgentStartResult;
    readonly context: ThreadPluginContext;
  };
  readonly "agent.end": {
    readonly event: AgentEndEvent;
    readonly result: AgentEndResult;
    readonly context: ThreadPluginContext;
  };
  readonly "tool.call": {
    readonly event: ToolCallEvent;
    readonly result: ToolCallResult;
    readonly context: ThreadPluginContext;
  };
  readonly "tool.result": {
    readonly event: ToolResultEvent;
    readonly result: ToolResultResult;
    readonly context: ThreadPluginContext;
  };
  readonly "trigger.received": {
    readonly event: TriggerReceivedEvent;
    readonly result: undefined;
    readonly context: TriggerPluginContext;
  };
  readonly "changes.prompt": {
    readonly event: ChangesPromptEvent;
    readonly result: ChangesPromptResult;
    readonly context: ThreadPluginContext;
  };
  /**
   * The Thread was archived: clean up, such as stopping a device. Sent once, 10 seconds, no Orb; the agent is stopped
   * and prompts still waiting were cancelled.
   */
  readonly "thread.archived": {
    readonly event: ThreadArchiveEvent;
    readonly result: undefined;
    readonly context: ThreadPluginContext;
  };
  /** The Thread was restored from the archive. Sent once, 10 seconds. */
  readonly "thread.unarchived": {
    readonly event: ThreadArchiveEvent;
    readonly result: undefined;
    readonly context: ThreadPluginContext;
  };
  // ─── Schedules and listeners ───
  /**
   * One run of a manifest schedule, for a plugin with no `service` (with
   * one, the service gets `POST /jobs/<name>`). Runs as the install's person
   * with 5 minutes; no Thread, no Orb.
   */
  readonly "job.run": {
    readonly event: JobRunEvent;
    readonly result: undefined;
    readonly context: BackgroundPluginContext;
  };
  /**
   * One message on a manifest listener's `url` (a `wss://` WebSocket or an
   * `https://` event stream), which dx keeps open. Messages of one listener
   * arrive one at a time, in order; at most 100 wait, the oldest go first.
   * Each has 5 minutes, as the install's person; no Thread, no Orb.
   */
  readonly "listener.event": {
    readonly event: ListenerEvent;
    readonly result: undefined;
    readonly context: BackgroundPluginContext;
  };
}

/** `job.run`: one occurrence of a manifest schedule. */
export interface JobRunEvent {
  /** The schedule's `name` in the manifest. */
  readonly name: string;
  /** When this occurrence was due (ISO 8601); a late run keeps it. */
  readonly scheduledAt: string;
}

/** `listener.event`: one message a listener's URL sent. */
export interface ListenerEvent {
  /** The listener's `name` in the manifest. */
  readonly name: string;
  /** A WebSocket text message or an event's `data`, parsed as JSON when it is JSON. */
  readonly data: unknown;
}

/** The Thread that was archived or restored. */
export interface ThreadArchiveEvent {
  readonly threadId: string;
}

/**
 * An item's icon: `lucide:<name>` (dx's icon set, such as
 * `lucide:smartphone`) or a path to an `.svg` or `.png` under `assets/`.
 * Without one, the item shows the plugin's icon.
 */
export type PluginItemIcon = `lucide:${string}` | `assets/${string}`;

export type PluginEventName = keyof PluginEvents;

/**
 * A handler for one event. It must also be listed in the manifest's
 * `permissions.events`; dx sends no other event. Each handler has 10
 * seconds; a `trigger.received` handler 25, and a `job.run` or
 * `listener.event` handler the install's call time (5 minutes).
 */
export type PluginEventHandler<E extends PluginEventName> = (
  event: PluginEvents[E]["event"],
  ctx: PluginEvents[E]["context"],
) => PluginEvents[E]["result"] | Promise<PluginEvents[E]["result"]>;

// ─── Tools ──────────────────────────────────────────────────────────────────

/** A JSON Schema object describing a tool's input. */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: ReadonlyArray<string>;
  readonly [keyword: string]: unknown;
}

/**
 * A tool the agent can call. Its name is what the model sees: lowercase
 * letters, digits, and underscores, starting with a letter, at most 48
 * characters. A name another tool already has is not mounted.
 */
export interface PluginToolDefinition<Input = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonSchemaObject;
  /** The icon on the tool's row in the transcript. */
  readonly icon?: PluginItemIcon;
  /**
   * Runs the call. The result reaches the model as text: strings as they
   * are, anything else as JSON. Each call has 5 minutes (60 seconds for a
   * plugin a repository carries).
   */
  readonly execute: (input: Input, ctx: ThreadPluginContext) => unknown;
}

// ─── UI ─────────────────────────────────────────────────────────────────────

/**
 * What every prompt takes. A prompt shows above the Thread's composer to
 * the owner and Contribute members, one at a time in the order asked, and
 * the call waits for an answer. The agent never sees or answers it.
 */
export interface PluginPromptOptions {
  /** At most 120 characters. */
  readonly title: string;
  /** Plain text under the title, at most 2,000 characters. */
  readonly message?: string;
  /**
   * How long to wait, in seconds: 300 by default, at most 1,800. When nobody
   * answers in time the prompt resolves `null`. The handler's or tool's own
   * time limit stops while a prompt waits.
   */
  readonly timeoutSeconds?: number;
}

/** A value the person may edit before confirming. */
export interface PluginPromptField {
  /** The key the edited value comes back under. */
  readonly key: string;
  readonly label: string;
  /** The value shown for editing, at most 4,000 characters. */
  readonly value: string;
  readonly multiline?: boolean;
}

export interface PluginConfirmOptions extends PluginPromptOptions {
  /** At most 40 characters each. */
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Draws the confirm button as a destructive action. */
  readonly destructive?: boolean;
}

export interface PluginConfirmWithFieldsOptions extends PluginConfirmOptions {
  /** Up to 8 values the person may edit before confirming. */
  readonly fields: ReadonlyArray<PluginPromptField>;
}

export interface PluginInputOptions extends PluginPromptOptions {
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly multiline?: boolean;
  /**
   * Only the Thread's owner may answer, the field hides what they type, and
   * dx clears the answer once the plugin has read it.
   */
  readonly secret?: boolean;
}

export interface PluginSelectChoice {
  /** What `select` resolves to, at most 200 characters. */
  readonly value: string;
  /** At most 120 characters. */
  readonly label: string;
  /** At most 300 characters. */
  readonly description?: string;
}

export interface PluginSelectOptions extends PluginPromptOptions {
  /** 1 to 20 choices, each with its own value. */
  readonly options: ReadonlyArray<PluginSelectChoice>;
}

export type PluginNoticeLevel = "info" | "success" | "warning" | "error";

/**
 * dx's own UI in the Thread, drawn by dx from what the plugin passes. Needs
 * `permissions.ui`: `prompt` for `confirm`, `input`, and `select`, and
 * `notify` for `notify`. A method the manifest did not grant rejects.
 */
export interface PluginUi {
  /**
   * Asks yes or no. Resolves `true` or `false`, or `null` when nobody
   * answered in time.
   */
  confirm(options: PluginConfirmOptions): Promise<boolean | null>;
  /**
   * Asks yes or no with values to edit. Resolves the edited values by key,
   * `false` when declined, or `null` when nobody answered in time.
   */
  confirm(
    options: PluginConfirmWithFieldsOptions,
  ): Promise<Readonly<Record<string, string>> | false | null>;
  /** Asks for text. Resolves it, or `null` when dismissed or unanswered. */
  input(options: PluginInputOptions): Promise<string | null>;
  /**
   * Asks for one of `options`. Resolves its value, or `null` when dismissed
   * or unanswered.
   */
  select(options: PluginSelectOptions): Promise<string | null>;
  /**
   * Shows a toast to everyone who has the Thread open, and to anyone who
   * opens it within a minute. At most 500 characters, 10 a minute.
   */
  notify(
    message: string,
    options?: { readonly level?: PluginNoticeLevel },
  ): Promise<void>;
}

/**
 * What a quick action button does: send `text` as the person's next
 * message, copy `text`, open an https `url` in a new tab, or run one of
 * this plugin's palette commands by id.
 */
export type PluginQuickActionSpec =
  | {
      readonly label: string;
      readonly action: "send-message" | "copy";
      readonly args: { readonly text: string };
    }
  | {
      readonly label: string;
      readonly action: "open-url";
      readonly args: { readonly url: string };
    }
  | {
      readonly label: string;
      readonly action: "run-command";
      readonly args: { readonly command: string };
    };

/** At most this many plugin quick actions show in one Thread. */
export const MAX_QUICK_ACTIONS_PER_THREAD = 5;

// ─── Thread access ──────────────────────────────────────────────────────────

/** A text block in a message. */
export interface ThreadTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** The agent's reasoning, when the model shows it. */
export interface ThreadThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
}

/** A tool call the agent made. Inputs over 4,000 characters of JSON are cut. */
export interface ThreadToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * A tool call's result. dx keeps it in the assistant message,
 * right after its `tool_use`. Outputs over 4,000 characters of JSON come as
 * `{ truncated: true, preview }`.
 */
export interface ThreadToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseID: string;
  readonly status: "done" | "error" | "running";
  readonly output?: unknown;
}

/** Who wrote a user message. */
export type ThreadMessageAuthor =
  | {
      readonly kind: "person";
      readonly userId: string;
      readonly name: string;
    }
  /** A plugin posted it, this one or another. */
  | {
      readonly kind: "plugin";
      readonly pluginId: string;
      readonly name: string;
    }
  /** Another of the owner's Threads sent it with a Thread tool. */
  | { readonly kind: "thread"; readonly threadId: string }
  /** A schedule, GitHub subscription, artifact, or webhook delivered it. */
  | { readonly kind: "automation"; readonly automation: string };

export interface ThreadUserMessage {
  readonly role: "user";
  readonly id: string;
  /** ISO 8601. */
  readonly createdAt?: string;
  /** The text, without dx's author tag; each block at most 32,000 characters. */
  readonly content: ReadonlyArray<ThreadTextBlock>;
  readonly author?: ThreadMessageAuthor;
  /** Chat between people, or a plugin's note: recorded without a model call. */
  readonly note?: true;
}

export interface ThreadAssistantMessage {
  readonly role: "assistant";
  readonly id: string;
  readonly createdAt?: string;
  /** Absent while the reply is still streaming. */
  readonly stopReason?: "end_turn" | "tool_use" | "cancelled";
  readonly content: ReadonlyArray<
    | ThreadTextBlock
    | ThreadThinkingBlock
    | ThreadToolUseBlock
    | ThreadToolResultBlock
  >;
}

/** A message in a Thread. */
export type ThreadMessage = ThreadUserMessage | ThreadAssistantMessage;

/** At most this many messages come back from one `messages()` call. */
export const MAX_THREAD_MESSAGES = 20;

export interface ThreadMessagesOptions {
  /** Where to count from; `end` (the default) reads the latest messages. */
  readonly from?: "start" | "end";
  /** Messages to skip from `from`, at most 1,000. Defaults to 0. */
  readonly offset?: number;
  /** Defaults to 10, at most {@link MAX_THREAD_MESSAGES}. */
  readonly limit?: number;
  readonly roles?: ReadonlyArray<"user" | "assistant">;
}

/** A Thread's details. */
export interface ThreadInfo {
  readonly id: string;
  readonly title: string;
  /** `running` while the agent works. */
  readonly state: "idle" | "running";
  readonly archived: boolean;
  readonly projectId: string;
  readonly parentThreadId: string | null;
  readonly createdAt: string;
  readonly lastActivityAt: string | null;
  /** The caller's access: their own, or a workspace member's share. */
  readonly access: "owner" | "contribute" | "view";
}

/** A message a plugin posts; a plain string also works. */
export interface UserMessage {
  readonly type: "user-message";
  readonly content: string;
}

/** dx delivers a message sent while the agent works into its running turn. */
export interface AppendUserMessageOptions {
  /** Accepted for compatibility; dx always steers a working Thread. */
  readonly steer?: boolean;
}

/** Messages a plugin posts in one call, at most. */
export const MAX_THREAD_POSTS_PER_CALL = 5;
/** Posts a plugin makes into one Thread a minute, at most. */
export const MAX_THREAD_POSTS_PER_MINUTE = 10;

/**
 * What a plugin may do with a Thread it reaches. Reads need
 * `permissions.threads` `read`; posts need `post`. Each request runs as the
 * call's owner and reaches only Threads they could open:
 *
 * - a personal install, Threads the installer owns;
 * - a workspace install, the caller's Threads in that workspace's Projects
 *   or their private ones, and Threads members shared with that workspace;
 * - a repository plugin: none, since nobody approved its grants.
 *
 * From a Thread shared with its workspace, a plugin reaches only that
 * Thread, its parent, and its children. Spaces are out of reach. Posting
 * needs Contribute access and an active Thread; a post is at most 30,000
 * characters. In an agent turn that a plugin's message started, a plugin may
 * post only notes, so plugins cannot keep Threads working by answering each
 * other. Every request, allowed or refused, is recorded in the plugin audit.
 */
export interface PluginThreadAccess {
  /** The Thread's details. */
  readonly info?: () => Promise<ThreadInfo>;
  /** The Thread's title. */
  readonly title?: { get(): Promise<string> };
  /** Whether the agent is working. */
  readonly state?: { get(): Promise<ThreadInfo["state"]> };
  /**
   * Reads messages, oldest first within the page. Defaults to the latest
   * 10; combine `offset` and `limit` to page back.
   */
  readonly messages?: (
    options?: ThreadMessagesOptions,
  ) => Promise<ReadonlyArray<ThreadMessage>>;
  /**
   * Posts messages the agent answers, shown as this plugin's, never as the
   * person's.
   */
  readonly append?: (
    messages: ReadonlyArray<UserMessage | string>,
  ) => Promise<void>;
  readonly appendUserMessage?: (
    message: UserMessage | string,
    options?: AppendUserMessageOptions,
  ) => Promise<void>;
  /**
   * Posts a note: shown to everyone in the transcript as this plugin's, with
   * no model call. The agent reads it as background with its next message.
   */
  readonly note?: (text: string) => Promise<void>;
}

/** Another Thread, from `ctx.threads.get(id)`. */
export interface PluginThreadHandle extends PluginThreadAccess {
  readonly id: string;
}

/** Threads beyond the call's own. */
export interface PluginThreads {
  /**
   * Starts a Thread as the trigger's owner, at most five per delivery;
   * needs `permissions.threads` `create` (or `true`). Only a call outside
   * any Thread, such as a webhook trigger, may start Threads.
   */
  readonly create?: (options: {
    readonly prompt: string;
    readonly projectId?: string;
    readonly title?: string;
    /**
     * The id of one of this plugin's views whose `show` includes `app`:
     * it draws the new Thread's main area. Set only at creation.
     */
    readonly type?: string;
  }) => Promise<{ readonly threadId: string }>;
  /**
   * A handle for a Thread by id; needs `read` or `post`. It checks nothing
   * until you call it: a Thread out of reach rejects then.
   */
  readonly get?: (threadId: string) => PluginThreadHandle;
  /**
   * Opens a Thread as the install's person (a workspace install's
   * installer), from any call: a schedule, a listener, a tool. With `key`,
   * the Thread already open for that key (not archived or deleted) comes
   * back with `created: false`, so repeated incidents open one Thread. At
   * most 20 new Threads an hour. Needs `permissions.threads` `create`, on a
   * personal or workspace install. The same call a service makes with
   * `POST /threads`.
   */
  readonly open?: (options: {
    readonly prompt: string;
    /** 1 to 200 characters. */
    readonly key?: string;
    readonly title?: string;
    readonly projectId?: string;
  }) => Promise<{
    readonly threadId: string;
    readonly url: string;
    readonly created: boolean;
  }>;
  /**
   * Posts into an open Thread this install opened with `open`: a note (no
   * model call) by default, or with `wake: true` and the `post` grant, a
   * message the agent answers. Needs `create` or `post`. The same call a
   * service makes with `POST /threads/<id>/messages`.
   */
  readonly post?: (
    threadId: string,
    text: string,
    options?: { readonly wake?: boolean },
  ) => Promise<void>;
}

/** The Thread a call runs in. */
export interface PluginThread extends PluginThreadAccess {
  readonly id: string;
  /**
   * Adds a button above the composer, kept until removed or the plugin is
   * uninstalled. Labels are at most 48 characters; a Thread shows at most
   * {@link MAX_QUICK_ACTIONS_PER_THREAD}. Needs `permissions.ui`
   * `quick-action`.
   */
  readonly createQuickAction?: (
    action: PluginQuickActionSpec,
  ) => Promise<{ readonly id: string }>;
  /** Removes one of this plugin's quick actions; false when it was gone. */
  readonly removeQuickAction?: (id: string) => Promise<boolean>;
}

// ─── Commands ───────────────────────────────────────────────────────────────

/** How long a command runs unless `timeoutMs` says otherwise. */
export const SHELL_DEFAULT_TIMEOUT_MS = 30_000;
/** The longest `timeoutMs`; the call's own time limit still applies. */
export const SHELL_MAX_TIMEOUT_MS = 60_000;
/** stdout and stderr each keep at most their first this many bytes. */
export const SHELL_OUTPUT_BYTES = 131_072;

/** A finished command. It resolves also when the command exits non-zero. */
export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The command ran past its time limit; dx stopped it (exit code 124). */
  readonly timedOut: boolean;
  /**
   * stdout or stderr was longer than {@link SHELL_OUTPUT_BYTES}. A cut
   * stream also loses its last few KB, so a secret the cut split in half
   * never shows unmasked.
   */
  readonly truncated: boolean;
}

export interface PluginExecOptions {
  /** A folder in the Thread's checkout, relative to it; the checkout by default. */
  readonly cwd?: string;
  /** 1,000 to {@link SHELL_MAX_TIMEOUT_MS}; {@link SHELL_DEFAULT_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number;
}

/**
 * Runs a shell command in the Thread's Orb, written as a tagged template:
 *
 * ```js
 * const { exitCode, stdout } = await ctx.$`git log -1 --format=%s -- ${path}`;
 * const checks = await ctx.$.with({ timeoutMs: 20_000 })`gh pr checks ${pr} --json name,state`;
 * ```
 *
 * Each interpolated value becomes one quoted shell word, an array one word
 * per item and any other object its JSON, so text from a model or a person
 * can't inject commands. Only `ctx.$.raw(text)` goes in as written. There
 * is no `.nothrow()` or `.quiet()`.
 */
export interface ShellFunction {
  (
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Promise<ShellResult>;
  /** The same runner with a working folder or time limit, added to these. */
  with(options: PluginExecOptions): ShellFunction;
  /** Shell text that goes into the command unquoted, such as `| head -5`. */
  raw(text: string): ShellRawText;
}

/** What `ctx.$.raw` returns; only the runtime makes one. */
export interface ShellRawText {
  readonly text: string;
}

// ─── Context ────────────────────────────────────────────────────────────────

/** The install a call runs for. */
export interface PluginInstall {
  /**
   * A personal install serves one person; a workspace install its members.
   * A repository plugin comes from the Thread's repository and serves the
   * Project's Threads; it gets no secrets.
   */
  readonly scope: "personal" | "workspace" | "repository";
  readonly pluginName: string;
  /** dx's version of the plugin: its declared version plus a content hash. */
  readonly version: string;
}

/** Who a call runs for. */
export interface PluginCaller {
  /** The Thread's owner: everything in a Thread runs as its owner. */
  readonly userId: string;
}

/** Key-value storage for this install, kept by dx. Values are JSON. */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys that start with `prefix`, in order, at most 1,000. */
  list(prefix?: string): Promise<ReadonlyArray<string>>;
}

export type PluginSettingValue = string | number | boolean;

/**
 * A model to run on: a `provider/model` ID as dx's Model Routing names it,
 * such as `anthropic/claude-sonnet-5-5`, or one of dx's modes, `low`,
 * `medium`, `high`, or `ultra`, which run whatever model the owner set for
 * that mode. The manifest's `permissions.models` must list it.
 */
export type PluginModel =
  | "low"
  | "medium"
  | "high"
  | "ultra"
  | `${string}/${string}`;

/**
 * Reasoning effort, for models that support it. `none` asks for no
 * reasoning; dx sends the nearest level the model supports.
 */
export type PluginReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface PluginAiGenerateOptions {
  readonly prompt: string;
  readonly system?: string;
  /** At most 4,096. */
  readonly maxTokens?: number;
  /**
   * The model to ask. Omitted, the Thread's own model. A model the manifest
   * does not list in `permissions.models` rejects.
   */
  readonly model?: PluginModel;
  /** Omitted, low. */
  readonly reasoningEffort?: PluginReasoningEffort;
}

/**
 * Model calls on the owner's model connections, as their Threads' own calls
 * are: the same connections, workspace policy, and usage record. A Claude
 * Pro/Max plan serves only Claude Code, so a plugin cannot call a
 * `claude-code/...` model here.
 */
export interface PluginAi {
  generate(options: PluginAiGenerateOptions): Promise<string>;
}

export interface PluginLog {
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}

/**
 * What one call can reach. Only granted capabilities are present: `fetch`
 * needs `permissions.network`, `secrets` needs `permissions.secrets`,
 * `tools` needs `permissions.tools`, and `ai` needs `permissions.ai`
 * (`permissions.models` lists the models it may choose).
 * Storage, settings, and the log are always there; `$` and `exec` (on a
 * Thread's context) need `permissions.shell`. `ai` and `tools` need
 * a Thread, so a trigger's context has neither.
 */
export interface PluginContext {
  readonly install: PluginInstall;
  readonly caller: PluginCaller;
  /**
   * The install's key-value state, kept by dx. A plugin's service reads and
   * writes the same store (`/state` on DX_API), so state survives moving
   * code between the function and a service.
   */
  readonly storage: PluginStorage;
  readonly settings: {
    /** The install's settings, with each declared default filled in. */
    get(): Promise<Readonly<Record<string, PluginSettingValue>>>;
  };
  readonly log: PluginLog;
  /** HTTPS requests to the hosts `permissions.network` lists. */
  readonly fetch?: (
    input: string | URL,
    init?: {
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    },
  ) => Promise<Response>;
  readonly secrets?: {
    /** A granted secret's value, or undefined when none is set. */
    get(name: string): Promise<string | undefined>;
  };
  readonly tools?: {
    /** Calls a dx tool `permissions.tools` lists. Tool policy still applies. */
    call(
      name: string,
      input: Readonly<Record<string, unknown>>,
    ): Promise<unknown>;
  };
  readonly ai?: PluginAi;
  // ─── Hosts ───
  /**
   * Calls a function the plugin's code exposed with `dx.expose` in another
   * host: `ctx.host("orb").call("capture", { seconds: 5 })`. Present when
   * the manifest's `host` names an entry module per host; dx refuses a host
   * the manifest does not name.
   */
  host?(kind: PluginHostKind): {
    call<T = unknown>(fn: string, args?: unknown): Promise<T>;
  };
  /** Other plugins' exports; present when `permissions.plugins` lists any. */
  readonly plugins?: PluginCalls;
  /** Views described as data; present when the manifest declares any. */
  readonly views?: PluginViewState;
  // ─── Install actions ───
  /**
   * The install's cloud identity: an OIDC token whose subject names the
   * install (`dx:wid:v1:[w:<workspace>:]u:<owner>:i:<install>`), for a cloud
   * that trusts dx's issuer. `ttlSeconds` is 60 to 3600 (default 600). The
   * same call a service makes with `POST /id-token`. Present for a personal
   * or workspace install, never a repository's plugin.
   */
  readonly identity?: {
    token(
      audience: string,
      ttlSeconds?: number,
    ): Promise<{
      readonly token: string;
      /** Epoch seconds, as dx's other identity tokens say it. */
      readonly expiresAt: number;
    }>;
  };
}

/** Where a plugin's code runs; see the manifest's `host`. */
export type PluginHostKind = "worker" | "orb";

/**
 * The context of a schedule's `job.run` or a listener's `listener.event`:
 * no Thread, as the install's person (a workspace install's installer).
 * `ctx.threads.open` and `ctx.threads.post` reach Threads from here.
 */
export interface BackgroundPluginContext extends PluginContext {
  /** Present when `permissions.threads` grants any. */
  readonly threads?: PluginThreads;
}

// ─── The Orb host ───
/**
 * In the Orb host (the manifest's `host.orb` entry), the plugin runs as a
 * Node process in the Thread's own Orb, with the Thread's rights there, the
 * manifest's `binaries` on its PATH, and Node's own modules (`node:http`,
 * `node:child_process`) available. The process lives while a call runs,
 * and about a minute after. Plugin secrets
 * stay with the Worker code: `ctx.secrets` is refused there.
 *
 * There, `ctx.$` returns an {@link OrbShellRun}: dx admits each command
 * first with the same checks (`permissions.shell`, the Thread's
 * `tool.call` plugins, an audit row), then the process runs it itself and
 * streams its output, without the Worker host's 128 KB and 60 s caps: 60
 * seconds by default, up to 5 minutes with `timeoutMs`, keeping the first
 * 1 MiB of each stream. Output is not masked: the process
 * already runs with the Thread's environment.
 *
 *     for await (const { stream, text } of ctx.$`adb logcat -d`) ctx.log.info(text);
 */
export interface OrbShellRun
  extends Promise<ShellResult>,
    AsyncIterable<{
      readonly stream: "stdout" | "stderr";
      readonly text: string;
    }> {
  /** Ends the command and everything it started. */
  kill(): void;
}

/** The context of a call made inside a Thread: every event but triggers. */
export interface ThreadPluginContext extends PluginContext {
  readonly thread: PluginThread;
  /** Present when `permissions.ui` grants `prompt` or `notify`. */
  readonly ui?: PluginUi;
  /**
   * Shell commands in the Thread's Orb, in its checkout, as the Thread's
   * own commands run: with its environment, secrets, Git credentials, and
   * network, and with its secrets masked in the output. Needs
   * `permissions.shell`. Before each runs, the Thread's other plugins'
   * `tool.call` handlers see it as a `shell_command` call with `plugin` set
   * (and the whole command line, so don't put a secret in it) and may
   * reject it. `cwd` is where the command starts; the Orb, not the folder,
   * is the boundary. Limits count per plugin call. dx audits every command.
   *
   * Absent in a `tool.call` handler while it checks another plugin's
   * command, and in a webhook's context: a delivery has no Thread, so no
   * Orb. Start a Thread with `ctx.threads.create` and run them there.
   */
  readonly $?: ShellFunction;
  /** `ctx.$` for a command line you already built, quoted yourself. */
  readonly exec?: (
    command: string,
    options?: PluginExecOptions,
  ) => Promise<ShellResult>;
  /** Other Threads, with `get`; present when `permissions.threads` grants `read` or `post`. */
  readonly threads?: PluginThreads;
}

/** The context of a webhook delivery: no Thread exists yet. */
export interface TriggerPluginContext extends PluginContext {
  /**
   * Threads as the trigger's owner: `create` with `permissions.threads`
   * `create`, `get` with `read` or `post`.
   */
  readonly threads?: PluginThreads;
}

// ─── Agents ─────────────────────────────────────────────────────────────────

/**
 * Which tools an agent gets, by name as the model sees them. `all` (the
 * default) is every tool a Thread of its owner has: dx's tools, the
 * workspace's shell and file tools, and installed plugins' tools. A list
 * keeps only those names; `exclude` drops names after that. A name ending in
 * `*` matches every name with that start, such as `mcp_*`.
 */
export type PluginAgentTools =
  | "all"
  | ReadonlyArray<string>
  | {
      readonly include?: ReadonlyArray<string> | "all";
      readonly exclude?: ReadonlyArray<string>;
    };

/** How a Thread running the agent is labelled. */
export interface PluginAgentDisplay {
  /** At most 24 characters. */
  readonly label: string;
  /** A hex RGB color such as `#7c3aed`. */
  readonly color?: string;
}

/**
 * An agent the plugin defines. It runs as a dx
 * Thread: the agent's instructions join dx's own system prompt, its tools
 * filter what the model sees, and its model is the Thread's model, on the
 * owner's model connections and limits.
 */
export interface PluginAgentConfig {
  /**
   * 1 to 24 lowercase letters, digits, and hyphens, starting with a letter.
   * It names the agent in its Threads and in dx's audit.
   */
  readonly name: string;
  /**
   * What the agent does, written for the main agent deciding whether to
   * delegate to it. At most 300 characters.
   */
  readonly description?: string;
  /** Appended to dx's system prompt. At most 16,000 characters. */
  readonly instructions: string;
  /**
   * The model it runs on; the manifest's `permissions.models` must list it.
   * Omitted, the Thread that starts it decides, as a child Thread inherits
   * its parent's mode.
   */
  readonly model?: PluginModel;
  /** For a `provider/model` model. Omitted, the model's default. */
  readonly reasoningEffort?: PluginReasoningEffort;
  readonly tools?: PluginAgentTools;
  readonly display?: PluginAgentDisplay;
}

/** A plugin agent, frozen as dx validated it. */
export interface PluginAgentDefinition extends PluginAgentConfig {
  readonly kind: "agent-definition";
}

export interface PluginAgentRunOptions {
  /**
   * How long to wait for its answer, in milliseconds: 10 minutes by default,
   * at most 30. A timeout rejects the call but leaves the Thread running.
   * The calling tool's own time limit stops while it waits.
   */
  readonly timeoutMs?: number;
  /** The new Thread's title. Omitted, dx names it from the message. */
  readonly title?: string;
}

export interface PluginAgentRunResult {
  /** The Thread the agent ran in, a child of the calling Thread. */
  readonly threadId: string;
  /** The agent's final answer. */
  readonly text: string;
}

/** What `dx.createAgent` returns. Needs `permissions.agents`. */
export interface PluginAgent {
  readonly definition: PluginAgentDefinition;
  /**
   * Starts a child Thread of the calling Thread that runs this agent on
   * `message`, waits for its turn to finish, and resolves its answer. Only
   * inside a Thread (a tool, command, or event handler).
   */
  run(
    message: string,
    options?: PluginAgentRunOptions,
  ): Promise<PluginAgentRunResult>;
}

/**
 * An agent mode: dx lists it beside its own
 * modes, the main agent can start a Thread in it (`create_thread` with
 * `agent_mode: "plugin:<plugin name>/<key>"`), and so can people. Declare
 * each mode in the manifest's `agentModes` with the same `key`, so dx can
 * show it before running the code; a key the manifest does not declare
 * throws.
 */
export interface PluginAgentModeDefinition {
  readonly key: string;
  readonly agent: PluginAgentDefinition;
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * A command in dx's command palette while a Thread with the plugin is open,
 * for the owner and Contribute members. `run` gets the context of that
 * Thread and has 5 minutes (60 s for a repository's plugin), not counting
 * time its prompts wait.
 */
export interface PluginCommandDefinition {
  /** 1 to 48 lowercase letters, digits, and hyphens, starting with a letter. */
  readonly id: string;
  /** At most 80 characters. */
  readonly title: string;
  /** At most 200 characters. */
  readonly description?: string;
  /** The icon on the command's palette row. */
  readonly icon?: PluginItemIcon;
  readonly run: (ctx: ThreadPluginContext) => unknown;
}

/**
 * Turns text in the Thread's transcript into links. `url` is an https
 * template where `$0` is the whole match and `$1`…`$9` its groups.
 *
 * ```js
 * dx.registerLinkPattern({ pattern: /\bACME-(\d+)\b/, url: "https://acme.example/issues/$1" });
 * ```
 */
export interface PluginLinkPatternDefinition {
  /** A regular expression of at most 200 characters; `g` is implied. */
  readonly pattern: RegExp | string;
  /** `i`, `m`, `s`, or `u`, when `pattern` is a string. */
  readonly flags?: string;
  readonly url: string;
  /** Shown when hovering the link, at most 120 characters. */
  readonly title?: string;
}

// ─── Views and plugin calls ────────────────────────────────────────────

/** A chain of plugin calls (A calls B calls C) is at most this deep. */
export const MAX_PLUGIN_CALL_DEPTH = 3;

/** Why dx refused a `ctx.plugins.call`; each refusal is audited. */
export type PluginCallRefusedCode =
  /** `permissions.plugins` does not list the callee. */
  | "not-permitted"
  /** The callee is not installed, or is off, for this call's owner. */
  | "not-installed"
  /** The callee's manifest `exports` does not list the function. */
  | "not-exported"
  /** The call would loop back to a plugin already in the chain, or pass the depth limit. */
  | "cycle";

/**
 * What a refused `ctx.plugins.call` rejects with. Across the isolate
 * boundary it arrives as an `Error` whose `name` is `PluginCallRefused` and
 * whose message starts with `[<code>]`.
 */
export interface PluginCallRefused extends Error {
  readonly name: "PluginCallRefused";
  readonly code: PluginCallRefusedCode;
}

/**
 * Calls another plugin's exported function through dx. Needs the callee in
 * `permissions.plugins` and both plugins installed for the call's owner.
 * The callee runs with its own
 * permissions, settings, and secrets, never the caller's, and its time
 * counts against this call's own limit. dx audits every call.
 */
export interface PluginCalls {
  call<T = unknown>(plugin: string, fn: string, args?: unknown): Promise<T>;
}

/**
 * The state of the plugin's views described as data (the list form of the
 * manifest's `views`). dx draws each view from its JSON file and this state,
 * and every open browser updates when it changes. Paths are dot keys and
 * list indexes: `stats.errors`, `rows.0.status`; `""` is the whole state.
 * A view's state is at most 512 KB of JSON.
 */
export interface PluginViewState {
  /** Sets the value at `path`; resolves the state's new version. */
  set(viewId: string, path: string, value: unknown): Promise<number>;
  /** The view's state, or the value at `path` in it. */
  get(viewId: string, path?: string): Promise<unknown>;
  /**
   * What a tool returns, or spreads into its result, to show the view as a
   * card under the tool call: `return { ...summary, ...ctx.views.card("dashboard") }`.
   */
  card(viewId: string): {
    readonly _meta: { readonly "dev.dxcode/view": string };
  };
}

/** What an exported function learns about who called it. */
export interface PluginExportCaller {
  /** The calling plugin's name. */
  readonly plugin: string;
}

/** A function `dx.expose` publishes; the manifest's `exports` lists its name. */
export type PluginExportHandler = (
  args: unknown,
  ctx: PluginContext & { readonly calledBy?: PluginExportCaller },
) => unknown;

/** What the entry module's default export receives. */
export interface PluginAPI {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  /**
   * Handles an event. Several handlers for one event run in order; plugins
   * run workspace installs first, then personal, then repository plugins,
   * then by name.
   */
  on<E extends PluginEventName>(event: E, handler: PluginEventHandler<E>): void;
  registerTool<Input = Record<string, unknown>>(
    tool: PluginToolDefinition<Input>,
  ): void;
  /** Adds a command palette entry; at most 16 per plugin. */
  registerCommand(command: PluginCommandDefinition): void;
  /** Links matching transcript text; at most 16 per plugin. */
  registerLinkPattern(link: PluginLinkPatternDefinition): void;
  /**
   * Defines an agent its code can run with `run`, or register as a mode.
   * Needs `permissions.agents`; call it while the plugin starts.
   */
  createAgent(config: PluginAgentConfig): PluginAgent;
  /** Lists an agent as a mode the manifest's `agentModes` declares. */
  registerAgentMode(mode: PluginAgentModeDefinition): void;
  // ─── Hosts and plugin calls ───
  /**
   * Names functions other hosts of this plugin may call with
   * `ctx.host(kind).call(name, args)`, and other plugins may call with
   * `ctx.plugins.call` when the manifest's `exports` lists the name.
   * Arguments and results are JSON. Call it while the plugin starts.
   */
  expose(handlers: Readonly<Record<string, PluginExportHandler>>): void;
}

/** The shape of a plugin's entry module. */
export type PluginEntry = (dx: PluginAPI) => void | Promise<void>;

/** Types a plugin's default export: `export default definePlugin((dx) => …)`. */
export const definePlugin = (entry: PluginEntry): PluginEntry => entry;
