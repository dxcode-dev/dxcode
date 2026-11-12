import { parseMessageAuthor } from "@dx/api";
import type { PluginCodeEvent } from "@dx/domain";
import {
  type AgentFinishContext,
  type AgentStartContext,
  type ToolDefinition,
  useAgentFinish,
  useAgentStart,
  usePersistentState,
} from "@flue/runtime";
import * as v from "valibot";
import type { Bindings } from "../../http/types.js";
import type { PluginHostDependencies, PluginInstallRecord } from "./host.js";
import type { ResolvedCodePlugin } from "./resolve.js";
import type { PluginShellGate } from "./shell.js";
import { messageAuthorOf } from "./thread-access.js";
import {
  callPluginTool,
  dispatchPluginEvent,
  logPluginFailure,
} from "./worker.js";

/**
 * Where plugin code meets a Thread's agent: the `tool.call` and
 * `tool.result` gate around every dx tool, the tools plugins register, and
 * the `session.start`, `agent.start`, and `agent.end` hooks. A `tool.call`
 * handler that fails rejects the call (fail closed); every other event
 * fails open and the failure is logged into the Thread.
 */

export const PLUGIN_SIGNAL = "plugin";
export const MAX_AGENT_END_CONTINUATIONS = 5;

export interface CodePluginRuntime {
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly plugins: ReadonlyArray<ResolvedCodePlugin>;
  readonly host: () => { readonly db: D1Database; readonly bindings: Bindings };
}

const handles = (plugin: ResolvedCodePlugin, event: PluginCodeEvent) =>
  plugin.events.includes(event);

/**
 * Threads whose current agent turn a plugin's posted message started. The
 * turn's plugin calls may then post only notes, and the turn does not reset
 * `agent.end`'s continuation count: a plugin cannot keep a Thread working by
 * posting into it, or two plugins by posting into each other's Threads.
 */
const pluginStartedTurns = new Set<string>();

const dependencies = (
  runtime: CodePluginRuntime,
  plugin: ResolvedCodePlugin,
  callTool?: PluginHostDependencies["callTool"],
  /** False while the call checks another plugin's command. */
  shell = true,
): PluginHostDependencies => ({
  ...runtime.host(),
  install: plugin,
  threadId: runtime.threadId,
  ownerUserId: runtime.ownerUserId,
  ...(callTool === undefined ? {} : { callTool }),
  ...(shell && plugin.code.permissions.shell === true
    ? { shellGate: pluginShellGate(runtime, plugin) }
    : {}),
  ...(pluginStartedTurns.has(runtime.threadId)
    ? { turnStartedByPlugin: true }
    : {}),
});

/** Workspace gates run last, so a workspace policy decides on the input
 * every personal plugin's modify produced. */
const gateOrder = (plugins: ReadonlyArray<ResolvedCodePlugin>) =>
  plugins
    .filter((plugin) => handles(plugin, "tool.call"))
    .sort(
      (left, right) =>
        Number(left.scope === "workspace") -
        Number(right.scope === "workspace"),
    );

/**
 * A plugin's own commands (`ctx.$`) pass the Thread's other plugins'
 * `tool.call` handlers as a `shell_command` call with `plugin` set, as the
 * agent's commands do. The calling plugin does not check itself, and a
 * handler checking a plugin's command runs no commands of its own, so
 * checks never recurse.
 */
export const pluginShellGate = (
  runtime: CodePluginRuntime,
  caller: Pick<PluginInstallRecord, "pluginId" | "name">,
  /**
   * Gates the runtime does not hold yet, read once from the open
   * workspace when the first command needs them (a route call has no
   * repository plugins resolved). A failure refuses the command.
   */
  moreGates?: (
    workspace: Parameters<PluginShellGate>[1],
  ) => Promise<ReadonlyArray<ResolvedCodePlugin>>,
): PluginShellGate => {
  let extra: Promise<ReadonlyArray<ResolvedCodePlugin>> | undefined;
  return async ({ command, workdir }, workspace) => {
    let added: ReadonlyArray<ResolvedCodePlugin> = [];
    if (moreGates !== undefined) {
      extra ??= moreGates(workspace);
      try {
        added = await extra;
      } catch (error) {
        extra = undefined;
        return {
          kind: "reject",
          message: `dx could not read this Thread's repository plugins to check the command, so it did not run (${message(error)}).`,
        };
      }
    }
    const gates = gateOrder(
      [...runtime.plugins, ...added].filter(
        (plugin) => plugin.pluginId !== caller.pluginId,
      ),
    );
    if (gates.length === 0)
      return { kind: "allow", input: { command, workdir } };
    const decision = await decide(
      runtime,
      gates,
      {
        tool: "shell_command",
        callId: `plugin-shell-${crypto.randomUUID()}`,
        input: { command, workdir },
        plugin: caller.name,
      },
      true,
    );
    return decision.kind === "allow"
      ? { kind: "allow", input: decision.input }
      : decision;
  };
};

const message = (error: unknown) =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "it failed without a message";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ToolRun = ToolDefinition["run"];
type ToolRunContext = Parameters<ToolRun>[0];
type ToolRunResult = Awaited<ReturnType<ToolRun>>;

/** What the model would read from a tool's return value. */
const outputOf = (result: ToolRunResult): unknown =>
  typeof result === "string"
    ? result
    : isRecord(result) && "output" in result
      ? result.output
      : null;

const replaceOutput = (result: ToolRunResult, output: unknown) =>
  (isRecord(result)
    ? { ...result, output }
    : typeof output === "string"
      ? output
      : { output }) as ToolRunResult;

/** How one tool shape runs and reads its result, for the event gate. */
interface GatedCall<R> {
  readonly tool: string;
  readonly callId: string;
  readonly input: Record<string, unknown>;
  readonly run: (input: Record<string, unknown>) => Promise<R>;
  readonly outputOf: (result: R) => unknown;
  readonly replace: (result: R | undefined, output: unknown) => R;
}

/** What installed plugins' `tool.call` handlers decided about one call. */
export type PluginToolDecision =
  | {
      readonly kind: "allow";
      /** The input after every `modify`; the call's own when none. */
      readonly input: Record<string, unknown>;
      readonly modified: boolean;
    }
  | { readonly kind: "reject"; readonly message: string }
  | { readonly kind: "synthesize"; readonly output: unknown };

/**
 * Runs the gates for one call, in order. A throwing, timed-out, or
 * unstarted gate rejects it: the decision never fails open.
 */
const decide = async (
  runtime: CodePluginRuntime,
  gates: ReadonlyArray<ResolvedCodePlugin>,
  call: {
    readonly tool: string;
    readonly callId: string;
    readonly input: Record<string, unknown>;
    /** The plugin whose code made the call, when the agent did not. */
    readonly plugin?: string;
  },
  /** The call is a plugin's command: its gates run no commands. */
  nested = false,
): Promise<PluginToolDecision> => {
  let input = call.input;
  let modified = false;
  const reject = (text: string) => ({ kind: "reject", message: text }) as const;
  for (const plugin of gates) {
    if (plugin.loadError !== undefined)
      return reject(
        `${plugin.displayName} checks every tool call, and its code did not start, so dx did not run ${call.tool}: ${plugin.loadError}`,
      );
    let decision: unknown;
    try {
      decision = await dispatchPluginEvent(
        dependencies(runtime, plugin, undefined, !nested),
        "tool.call",
        {
          threadId: runtime.threadId,
          tool: call.tool,
          callId: call.callId,
          input,
          ...(call.plugin === undefined ? {} : { plugin: call.plugin }),
        },
      );
    } catch (error) {
      logPluginFailure(plugin, "tool.call", error);
      return reject(
        `${plugin.displayName} did not allow ${call.tool}: its tool.call handler failed (${message(error)}).`,
      );
    }
    // Only nothing, null, or an explicit allow lets the call through.
    if (
      decision === undefined ||
      decision === null ||
      (isRecord(decision) && decision.action === "allow")
    )
      continue;
    if (!isRecord(decision))
      return reject(
        `${plugin.displayName} did not allow ${call.tool}: its tool.call handler returned ${JSON.stringify(decision).slice(0, 80)}.`,
      );
    if (decision.action === "reject-and-continue")
      return reject(
        typeof decision.message === "string" && decision.message !== ""
          ? decision.message
          : `${plugin.displayName} rejected this ${call.tool} call.`,
      );
    if (decision.action === "synthesize")
      return { kind: "synthesize", output: decision.output ?? null };
    if (decision.action === "modify" && isRecord(decision.input)) {
      input = decision.input;
      modified = true;
      continue;
    }
    return reject(
      `${plugin.displayName} returned a tool.call result dx does not know, so ${call.tool} did not run.`,
    );
  }
  return { kind: "allow", input, modified };
};

/**
 * Runs `tool.call` handlers before a tool and `tool.result` handlers after
 * it. Plugins run in the resolved order; the first that does not allow the
 * call decides it, and a `modify` hands its input to the next.
 */
const runGated = async <R>(
  runtime: CodePluginRuntime,
  gates: ReadonlyArray<ResolvedCodePlugin>,
  observers: ReadonlyArray<ResolvedCodePlugin>,
  call: GatedCall<R>,
): Promise<R> => {
  const decision = await decide(runtime, gates, call);
  if (decision.kind === "reject") throw new Error(decision.message);
  if (decision.kind === "synthesize")
    return call.replace(undefined, decision.output);
  const { input } = decision;
  const notify = async (
    result:
      | { readonly status: "done"; readonly output: unknown }
      | { readonly status: "error"; readonly error: string },
  ) => {
    let output = result.status === "done" ? result.output : undefined;
    let modified = false;
    for (const plugin of observers) {
      try {
        const answer = await dispatchPluginEvent(
          dependencies(runtime, plugin),
          "tool.result",
          {
            threadId: runtime.threadId,
            tool: call.tool,
            callId: call.callId,
            input,
            ...result,
            ...(result.status === "done" ? { output } : {}),
          },
        );
        if (
          result.status === "done" &&
          isRecord(answer) &&
          answer.action === "modify"
        ) {
          output = answer.output;
          modified = true;
        }
      } catch (error) {
        logPluginFailure(plugin, "tool.result", error);
      }
    }
    return { output, modified };
  };
  let result: R;
  try {
    result = await call.run(input);
  } catch (error) {
    await notify({ status: "error", error: message(error) });
    throw error;
  }
  if (observers.length === 0) return result;
  const observed = await notify({
    status: "done",
    output: call.outputOf(result),
  });
  return observed.modified ? call.replace(result, observed.output) : result;
};

const gatesOf = (runtime: CodePluginRuntime | undefined) => {
  if (runtime === undefined) return undefined;
  const gates = gateOrder(runtime.plugins);
  const observers = runtime.plugins.filter(
    (plugin) =>
      handles(plugin, "tool.result") && plugin.loadError === undefined,
  );
  return gates.length === 0 && observers.length === 0
    ? undefined
    : { runtime, gates, observers };
};

/**
 * The decision for a tool dx does not run itself, such as Claude Code's
 * own tools, which Claude Code's PreToolUse hook asks about. Undefined
 * when no installed plugin gates tool calls.
 */
export const decidePluginToolCall = (
  runtime: CodePluginRuntime | undefined,
  call: {
    readonly tool: string;
    readonly callId: string;
    readonly input: Record<string, unknown>;
  },
): Promise<PluginToolDecision> | undefined => {
  const gated = gatesOf(runtime);
  return gated === undefined || gated.gates.length === 0
    ? undefined
    : decide(gated.runtime, gated.gates, call);
};

/** A dx tool behind installed plugins' `tool.call` and `tool.result`. */
export const withPluginToolEvents = <T extends ToolDefinition>(
  tool: T,
  runtime: CodePluginRuntime | undefined,
): T => {
  const gated = gatesOf(runtime);
  if (gated === undefined) return tool;
  return {
    ...tool,
    run: (context: ToolRunContext) => {
      const data = (context as { readonly data?: unknown }).data;
      return runGated<ToolRunResult>(
        gated.runtime,
        gated.gates,
        gated.observers,
        {
          tool: tool.name,
          callId: context.toolCallId,
          input: isRecord(data) ? data : {},
          run: async (input) => tool.run({ ...context, data: input } as never),
          outputOf,
          replace: replaceOutput,
        },
      );
    },
  } as T;
};

interface WorkspaceToolResult {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  readonly details?: unknown;
  readonly isError?: boolean;
}

interface WorkspaceTool {
  readonly name: string;
  readonly execute: (
    toolCallId: string,
    params: never,
    ...rest: never[]
  ) => Promise<WorkspaceToolResult>;
}

const workspaceText = (result: WorkspaceToolResult) =>
  result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

/** A workspace tool (shell, files) behind the same gate. */
export const withPluginWorkspaceToolEvents = <T extends WorkspaceTool>(
  tool: T,
  runtime: CodePluginRuntime | undefined,
): T => {
  const gated = gatesOf(runtime);
  if (gated === undefined) return tool;
  return {
    ...tool,
    execute: (toolCallId: string, params: never, ...rest: never[]) =>
      runGated<WorkspaceToolResult>(
        gated.runtime,
        gated.gates,
        gated.observers,
        {
          tool: tool.name,
          callId: toolCallId,
          input: isRecord(params) ? params : {},
          run: (input) => tool.execute(toolCallId, input as never, ...rest),
          outputOf: (result) =>
            result.isError === true
              ? { error: workspaceText(result) }
              : workspaceText(result),
          replace: (result, output) => ({
            ...(result ?? {}),
            content: [
              {
                type: "text",
                text:
                  typeof output === "string"
                    ? output
                    : JSON.stringify(output ?? null, null, 2),
              },
            ],
            details: result?.details,
          }),
        },
      ),
  } as T;
};

/** A JSON Schema property as a loose Valibot schema the model can read. */
const propertySchema = (property: unknown): v.GenericSchema => {
  const description =
    isRecord(property) && typeof property.description === "string"
      ? property.description
      : undefined;
  const type = isRecord(property) ? property.type : undefined;
  const values = isRecord(property) ? property.enum : undefined;
  const base: v.GenericSchema =
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === "string")
      ? v.picklist(values as [string, ...string[]])
      : type === "string"
        ? v.string()
        : type === "number" || type === "integer"
          ? v.number()
          : type === "boolean"
            ? v.boolean()
            : type === "array"
              ? v.array(v.unknown())
              : type === "object"
                ? v.looseObject({})
                : v.unknown();
  return description === undefined
    ? base
    : v.pipe(base, v.description(description.slice(0, 1_024)));
};

export const pluginToolInput = (schema: Readonly<Record<string, unknown>>) => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const entries: Record<string, v.GenericSchema> = {};
  for (const [key, property] of Object.entries(properties).slice(0, 64)) {
    const value = propertySchema(property);
    entries[key] = required.has(key) ? value : v.optional(value);
  }
  return v.looseObject(entries);
};

/** Valid tool names a plugin registered; a name another tool has is left out. */
/** A plugin tool's name: what the model sees, checked here, not in the worker. */
const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * Names Flue, the workspace, or Claude Code mode use outside the dx tool
 * list; a plugin tool by one of them would fail every submission.
 */
const RESERVED_TOOL_NAMES = new Set([
  "activate_skill",
  "bash",
  "cat",
  "code_exec",
  "create_file",
  "edit",
  "edit_file",
  "finish",
  "give_up",
  "glob",
  "grep",
  "ls",
  "read",
  "read_web_page",
  "shell_command",
  "shell_command_kill",
  "shell_command_status",
  "task",
  "tool_search",
  "view_media",
  "web_search",
  "write",
]);

const MAX_TOOL_SCHEMA_BYTES = 16_384;

const pluginToolNameAllowed = (name: string) =>
  PLUGIN_TOOL_NAME.test(name) &&
  !RESERVED_TOOL_NAMES.has(name) &&
  !name.startsWith("mcp_") &&
  !name.startsWith("dx_");

export const createPluginTools = (
  runtime: CodePluginRuntime | undefined,
  taken: ReadonlySet<string>,
  threadTools: () => ReadonlyArray<ToolDefinition>,
): ToolDefinition[] => {
  if (runtime === undefined) return [];
  const names = new Set(taken);
  const tools: ToolDefinition[] = [];
  for (const plugin of runtime.plugins) {
    if (plugin.loadError !== undefined) continue;
    for (const registered of plugin.tools) {
      if (
        names.has(registered.name) ||
        !pluginToolNameAllowed(registered.name) ||
        JSON.stringify(registered.inputSchema).length > MAX_TOOL_SCHEMA_BYTES
      ) {
        logPluginFailure(
          plugin,
          `register ${registered.name}`,
          new Error(
            "The name is taken, reserved, or malformed, or its input schema is too large.",
          ),
        );
        continue;
      }
      names.add(registered.name);
      tools.push({
        name: registered.name,
        description: `${registered.description}\n\n(From the ${plugin.displayName} plugin.)`,
        input: pluginToolInput(registered.inputSchema),
        output: undefined,
        harness: true,
        async run(context: ToolRunContext) {
          let calls = 0;
          const callTool = async (
            name: string,
            input: Readonly<Record<string, unknown>>,
          ) => {
            const target = threadTools().find((tool) => tool.name === name);
            if (target === undefined)
              throw new Error(`This Thread has no tool named ${name}.`);
            calls += 1;
            if (calls > 32)
              throw new Error("A plugin tool call may call at most 32 tools.");
            const result = await target.run({
              ...context,
              toolCallId: `${context.toolCallId}.${calls}`,
              data: input,
            } as never);
            return outputOf(result);
          };
          const data = (context as { readonly data?: unknown }).data;
          const output = await callPluginTool(
            dependencies(runtime, plugin, callTool),
            registered.name,
            isRecord(data) ? data : {},
          );
          return typeof output === "string"
            ? output
            : JSON.stringify(output ?? null, null, 2);
        },
      } as unknown as ToolDefinition);
    }
  }
  return tools;
};

const continuations = new Map<string, number>();

/** Who put the plugin in this Thread, for its signals. */
const pluginOrigin = (plugin: ResolvedCodePlugin) =>
  plugin.scope === "personal"
    ? `the ${plugin.displayName} plugin, which this Thread's owner installed`
    : plugin.scope === "workspace"
      ? `the ${plugin.displayName} plugin, which this Thread's workspace installed`
      : `the ${plugin.displayName} plugin, committed in this Thread's repository`;

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * `session.start` once per Thread, `agent.start` on each delivered message,
 * and `agent.end` when the agent would stop. An `agent.end` `continue`
 * keeps the response going, at most five times in a row.
 */
export const usePluginCodeLifecycle = (
  runtime: CodePluginRuntime | undefined,
  deliveredText: string,
) => {
  // Flue keys hook state by name, so it may be declared only when needed.
  if (runtime === undefined) return;
  const [sessionStarted, setSessionStarted] = usePersistentState<boolean>(
    "dx.plugins.session-started",
    false,
  );
  const running = runtime.plugins.filter(
    (plugin) => plugin.loadError === undefined,
  );
  const dispatch = async (
    plugin: ResolvedCodePlugin,
    event: PluginCodeEvent,
    payload: unknown,
    log: AgentStartContext["log"],
  ) => {
    try {
      return await dispatchPluginEvent(
        dependencies(runtime, plugin),
        event,
        payload,
      );
    } catch (error) {
      logPluginFailure(plugin, event, error);
      log.error(`The ${plugin.displayName} plugin's ${event} handler failed.`, {
        plugin: plugin.name,
        error: message(error),
      });
      return undefined;
    }
  };
  // Who sent the delivered message, so a plugin can tell its own posts and
  // people's messages apart.
  const deliveredAuthor = messageAuthorOf(parseMessageAuthor(deliveredText));
  // agent.end's continuation count resets on each delivered message, except
  // one a plugin posted: that turn counts toward the same limit.
  if (deliveredAuthor?.kind === "plugin")
    pluginStartedTurns.add(runtime.threadId);
  else {
    pluginStartedTurns.delete(runtime.threadId);
    continuations.delete(runtime.threadId);
  }
  if (
    running.some(
      (plugin) =>
        handles(plugin, "session.start") ||
        handles(plugin, "agent.start") ||
        handles(plugin, "agent.end"),
    )
  )
    useAgentStart(async ({ append, log }) => {
      if (!sessionStarted) {
        for (const plugin of running)
          if (handles(plugin, "session.start"))
            await dispatch(
              plugin,
              "session.start",
              { threadId: runtime.threadId },
              log,
            );
        setSessionStarted(true);
      }
      for (const plugin of running) {
        if (!handles(plugin, "agent.start")) continue;
        const result = await dispatch(
          plugin,
          "agent.start",
          {
            threadId: runtime.threadId,
            message: deliveredText,
            ...(deliveredAuthor === undefined
              ? {}
              : { author: deliveredAuthor }),
          },
          log,
        );
        if (
          isRecord(result) &&
          typeof result.context === "string" &&
          result.context.trim() !== ""
        )
          append({
            kind: "signal",
            type: PLUGIN_SIGNAL,
            body: `Context from ${pluginOrigin(plugin)}:\n\n${result.context.slice(0, 16_000)}`,
            attributes: {
              plugin: plugin.name,
              source: plugin.scope,
              event: "agent.start",
            },
          });
      }
    });
  if (running.some((plugin) => handles(plugin, "agent.end")))
    useAgentFinish(async ({ append, log, response }: AgentFinishContext) => {
      const count = continuations.get(runtime.threadId) ?? 0;
      if (count >= MAX_AGENT_END_CONTINUATIONS) return;
      for (const plugin of running) {
        if (!handles(plugin, "agent.end")) continue;
        const result = await dispatch(
          plugin,
          "agent.end",
          {
            threadId: runtime.threadId,
            toolCalls: response.toolCalls.map(({ tool, isError }) => ({
              tool,
              isError,
            })),
            continuations: count,
          },
          log,
        );
        if (
          isRecord(result) &&
          result.action === "continue" &&
          typeof result.message === "string" &&
          result.message.trim() !== ""
        ) {
          continuations.set(runtime.threadId, count + 1);
          append({
            kind: "signal",
            type: PLUGIN_SIGNAL,
            // Says where the plugin came from, so the model neither takes an
            // installed plugin's request for injected text nor trusts a
            // repository's plugin like one the owner installed.
            body: `${capitalize(pluginOrigin(plugin))} asks you to keep going before you end your turn:\n\n${result.message.slice(0, 16_000)}`,
            attributes: {
              plugin: plugin.name,
              source: plugin.scope,
              event: "agent.end",
            },
          });
          return;
        }
      }
    });
};
