import type {
  PluginBundleCode,
  PluginCodeEvent,
  PluginCodeThreadGrant,
  PluginCodeUiGrant,
  PluginPermission,
} from "./plugin-bundle.js";
import {
  isPluginRebuildMessage,
  pluginThreadGrants,
  RETIRED_PLUGIN_UI_GRANT,
} from "./plugin-bundle.js";
import { isCommandListener } from "./plugin-service.js";

/**
 * What a plugin can do, as sentences a person reads before installing or
 * updating it and on its Plugins page: "Calls api.linear.app", never
 * "Permission: network". Derived from the manifest alone, so the install
 * review, the update review, and the installed plugin say the same thing.
 */
export interface PluginCapability {
  /** Stable across versions, for lists and diffs. */
  readonly key: string;
  readonly text: string;
}

/** A plugin's contents as the manifest, a preview, or an install has them. */
export interface PluginCapabilityInput {
  readonly skills: ReadonlyArray<{ readonly name: string }>;
  /** Remote MCP servers by their URL. */
  readonly remoteServers: ReadonlyArray<{
    readonly name: string;
    readonly endpoint: string;
  }>;
  /** Local MCP servers by the command dxd runs in the Orb. */
  readonly localServers: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
  }>;
  readonly code?: PluginBundleCode | undefined;
}

/** "a", "a and b", "a, b, and c". */
export const listInWords = (items: ReadonlyArray<string>) =>
  items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

const hostOf = (endpoint: string) =>
  URL.canParse(endpoint) ? new URL(endpoint).host : endpoint;

const EVENT_TEXT = {
  "session.start": "Runs when a Thread starts",
  "agent.start": "Runs before each agent turn",
  "agent.end": "Runs after each agent turn",
  "tool.call": "Sees each tool call before it runs, and can stop it",
  "tool.result": "Sees what each tool call returns",
  "trigger.received": "Runs when one of its web addresses receives a request",
  "changes.prompt": "Can change the prompt Changes sends to the agent",
  "thread.archived": "Runs when a Thread is archived",
  "thread.unarchived": "Runs when a Thread is restored",
  "job.run": "Runs on its schedules",
  "listener.event": "Hears each message its listeners receive",
} as const satisfies Record<PluginCodeEvent, string>;

const UI_TEXT = {
  prompt: "Asks you questions above the message box",
  notify: "Shows notifications",
  "quick-action": "Adds buttons above the message box",
} as const satisfies Record<PluginCodeUiGrant, string>;

const THREAD_TEXT = {
  create: "Starts Threads as you",
  read: "Reads Threads you can open",
  post: "Posts messages into Threads",
} as const satisfies Record<PluginCodeThreadGrant, string>;

/** "every 15 minutes", "on a schedule", or "when it starts one". */
const schedule = (value: unknown) => {
  if (typeof value !== "object" || value === null) return "when it starts one";
  const every = (value as { readonly every?: unknown }).every;
  const cron = (value as { readonly cron?: unknown }).cron;
  const unit = { m: "minute", h: "hour", d: "day" } as const;
  if (typeof every === "string") {
    const count = Number(every.slice(0, -1));
    const name = unit[every.slice(-1) as keyof typeof unit] ?? "minute";
    return count === 1 ? `every ${name}` : `every ${count} ${name}s`;
  }
  return typeof cron === "string" ? "on a schedule" : "when it starts one";
};

/** Each thing the plugin can do, in the order a person checks them. */
export const pluginCapabilities = (
  input: PluginCapabilityInput,
): ReadonlyArray<PluginCapability> => {
  const out: Array<PluginCapability> = [];
  const add = (key: string, text: string) => out.push({ key, text });
  if (input.skills.length > 0)
    add(
      "skills",
      `Teaches dx ${input.skills.length === 1 ? "a skill" : `${input.skills.length} skills`}: ${listInWords(input.skills.map(({ name }) => name))}`,
    );
  for (const server of input.remoteServers)
    add(
      `mcp:${server.name}`,
      `Adds tools from ${hostOf(server.endpoint)} (${server.name})`,
    );
  for (const server of input.localServers)
    add(
      `command:${server.name}`,
      `Runs ${server.command} in each Thread's Orb to add tools (${server.name})`,
    );
  const code = input.code;
  if (code === undefined) return out;
  const { permissions } = code;
  if (permissions.network.length > 0)
    add(
      "network",
      `Calls ${listInWords(permissions.network.map((host) => (host.startsWith("*.") ? `any address under ${host.slice(2)}` : host)))}`,
    );
  if (permissions.secrets.length > 0)
    add(
      "secrets",
      `Uses your ${permissions.secrets.length === 1 ? "secret" : "secrets"} ${listInWords(permissions.secrets)}`,
    );
  if (permissions.tools.length > 0)
    add("tools", `Uses dx's ${listInWords(permissions.tools)} tools`);
  if (permissions.ai)
    add(
      "ai",
      (permissions.models ?? []).length === 0
        ? "Asks the Thread's model questions"
        : `Asks models questions: the Thread's model, or ${listInWords(permissions.models ?? [])}`,
    );
  if (permissions.agents === true)
    add(
      "agents",
      `Runs its own agents as Threads, on your model connections${
        (code.agentModes ?? []).length === 0
          ? ""
          : `, in ${listInWords((code.agentModes ?? []).map(({ label }) => label))} mode`
      }`,
    );
  for (const grant of pluginThreadGrants(permissions.threads))
    add(`threads:${grant}`, THREAD_TEXT[grant]);
  if (permissions.shell === true)
    add("shell", "Runs commands in each Thread's Orb, as you");
  if (code.hosts?.orb !== undefined)
    add(
      "orb",
      "Runs in each Thread's Orb, with its files, environment, and secrets",
    );
  // A program of its own on a plugin Orb: it costs Orb time while awake.
  if (code.service !== undefined) {
    add(
      "service",
      `Runs a program on a plugin Orb: ${code.service.run}${
        code.service.orb === "own" ? ", on an Orb of its own" : ""
      }${code.service.keepRunning ? ", kept running" : ", asleep when idle"}`,
    );
    for (const tool of code.service.tools ?? [])
      add(`service-tool:${tool.name}`, `Gives the agent the ${tool.name} tool`);
  }
  // Schedules and listeners: on the program when there is one, else inside
  // dx with no Orb, so no Orb cost.
  const where = code.service === undefined ? " inside dx, with no Orb" : "";
  for (const run of code.schedules ?? [])
    add(
      `schedule:${run.name}`,
      `Runs ${run.name} ${schedule("every" in run ? { every: run.every } : { cron: run.cron })}${where}, with no model`,
    );
  for (const listener of code.listeners ?? [])
    add(
      `listener:${listener.name}`,
      isCommandListener(listener)
        ? `Reads each line ${listener.run} prints`
        : `Listens to ${hostOf(listener.url)} inside dx, with no Orb`,
    );
  for (const grant of permissions.ui ?? [])
    if (grant !== RETIRED_PLUGIN_UI_GRANT) add(`ui:${grant}`, UI_TEXT[grant]);
  for (const event of permissions.events)
    add(`event:${event}`, EVENT_TEXT[event]);
  if ((permissions.plugins ?? []).length > 0)
    add(
      "plugins",
      `Calls the ${listInWords(permissions.plugins ?? [])} ${(permissions.plugins ?? []).length === 1 ? "plugin" : "plugins"}`,
    );
  if ((code.exports ?? []).length > 0)
    add(
      "exports",
      `Lets other plugins call ${listInWords((code.exports ?? []).map(({ name }) => name))}`,
    );
  for (const binary of code.binaries ?? [])
    add(`binary:${binary.name}`, `Installs ${binary.name} before it runs`);
  if (code.archivedThreads === "live")
    add("archived", "Keeps working in archived Threads");
  const required = code.settings.filter(({ required }) => required);
  if (required.length > 0)
    add(
      "settings",
      `Needs you to set ${listInWords(required.map(({ label }) => label))}`,
    );
  return out;
};

/** The internal names of where plugin code runs, as a person reads them. */
const HOST_CHANGE_TEXT: Readonly<Record<string, string>> = {
  orb: "Runs in each Thread's Orb, with its files, environment, and secrets",
  worker: "Runs its own code",
};

/**
 * One grant an update adds or drops, as a sentence: the update review's
 * line for `{ permission, value }` from the permission diff.
 */
export const pluginPermissionChangeText = (
  permission: PluginPermission,
  value: string,
): string => {
  switch (permission) {
    case "code":
      return value === "runs code"
        ? "Runs its own code"
        : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
    case "events":
      return value in EVENT_TEXT
        ? EVENT_TEXT[value as PluginCodeEvent]
        : `Runs on ${value}`;
    case "network":
      return `Calls ${value}`;
    case "secrets":
      return `Uses your secret ${value}`;
    case "tools":
      return `Uses dx's ${value} tool`;
    case "ui":
      return value in UI_TEXT ? UI_TEXT[value as PluginCodeUiGrant] : value;
    case "ai":
      return "Asks the Thread's model questions";
    case "threads":
      return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
    case "models":
      return `Asks ${value} questions`;
    case "agents":
      return value;
    case "shell":
      return "Runs commands in each Thread's Orb, as you";
    case "settings":
      return `Needs you to set ${value}`;
    case "mcp":
      return `Adds tools from ${value}`;
    case "commands":
      return `Runs ${value} in each Thread's Orb`;
    case "binaries":
      return `Installs ${value}`;
    case "plugins":
      return `Calls the ${value} plugin`;
    case "views":
      return value;
    case "exports":
      return `Lets other plugins call ${value}`;
    case "hosts":
      return HOST_CHANGE_TEXT[value] ?? "Runs in a new place";
    case "service":
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
};

/**
 * Why an installed plugin must be rebuilt, or undefined when it loads.
 * Two cases:
 * - The stored version uses a feature dx removed and no longer runs (its
 *   own container, the Durable Object's jobs, the manifest's `tier`): Core
 *   lists `pluginRebuildMessage` under what it skipped, and the plugin does
 *   not load.
 * - It asks for plugin panes or views its own code drew (`panes`,
 *   `paneConnect`, the object form of `views`, the `pane` UI grant), which
 *   dx removed: those decode unread and the rest of the plugin works.
 */
export const pluginRebuildReason = (bundle: {
  readonly skipped: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
  readonly code?: PluginBundleCode | undefined;
}): string | undefined => {
  const removed = bundle.skipped.find(({ reason }) =>
    isPluginRebuildMessage(reason),
  )?.reason;
  if (removed !== undefined) return removed;
  const code = bundle.code;
  if (code === undefined) return undefined;
  return code.panes !== undefined ||
    code.views !== undefined ||
    code.paneConnect !== undefined ||
    code.permissions.ui?.includes(RETIRED_PLUGIN_UI_GRANT) === true
    ? "It asks for panels or pages drawn by its own code, which dx removed."
    : undefined;
};
