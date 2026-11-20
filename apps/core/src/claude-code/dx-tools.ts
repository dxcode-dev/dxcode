import { type Context, getCurrentTools, Type } from "@earendil-works/pi-ai";
import type {
  FlueHarness,
  FlueLogger,
  Sandbox,
  SandboxToolFactory,
  ToolDefinition,
} from "@flue/runtime";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { claudeCodeLogger } from "../logging.js";
import { claudeCodeRuns } from "./runs.js";
import { UNREADABLE_TOOL_INPUT } from "./stream.js";
import {
  type ClaudeCodeDxTool,
  claudeCodeToolResultPath,
} from "./workspace-run.js";

/**
 * How Claude Code named a dx tool before the dx tool bridge (tool-bridge.ts)
 * served them without a prefix. Transcripts and Claude sessions from before
 * keep calls under this name.
 */
export const CLAUDE_CODE_LEGACY_DX_TOOL_PREFIX = "mcp__dx__";

/**
 * A dx tool's name as Claude sees it: dx's own snake_case name. Claude Code's
 * built-in tools are PascalCase, and another MCP server's tools start with
 * `mcp__`, so neither is ever taken for a dx tool.
 */
const DX_TOOL_NAME = /^[a-z][a-z0-9_]*$/;

export const isClaudeCodeDxTool = (name: string) =>
  name.startsWith(CLAUDE_CODE_LEGACY_DX_TOOL_PREFIX) ||
  (DX_TOOL_NAME.test(name) && !name.startsWith("mcp__"));

/** dx's name for a dx tool Claude called, under either naming. */
const dxToolName = (name: string) =>
  name.startsWith(CLAUDE_CODE_LEGACY_DX_TOOL_PREFIX)
    ? name.slice(CLAUDE_CODE_LEGACY_DX_TOOL_PREFIX.length)
    : name;

/** The text Claude receives: what the model would see for this result. */
const resultText = (result: unknown) => {
  if (typeof result === "string") return result;
  const output =
    result !== null && typeof result === "object" && "output" in result
      ? result.output
      : result;
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
};

/**
 * Images a dx tool shows Claude beside its text result, by tool call.
 * MCP results carry image blocks; Flue's record of the call keeps only the
 * text, so the image never enters the dx transcript as base64.
 */
const toolImages = new Map<
  string,
  { readonly data: string; readonly mimeType: string }
>();

export const showClaudeCodeToolImage = (
  toolCallId: string,
  image: { readonly data: string; readonly mimeType: string },
) => {
  toolImages.set(toolCallId, image);
};

/** The image a dx tool showed for this call, taken once. */
const takeImage = (toolCallId: string) => {
  const image = toolImages.get(toolCallId);
  toolImages.delete(toolCallId);
  return image;
};

const answer = async (
  sandbox: Sandbox,
  toolCallId: string,
  text: string,
  isError: boolean,
  image?: { readonly data: string; readonly mimeType: string },
) => {
  // A sandbox write creates missing parent directories.
  await sandbox.writeFile(
    claudeCodeToolResultPath(toolCallId),
    JSON.stringify({
      content: [
        { type: "text", text },
        ...(image === undefined || isError
          ? []
          : [{ type: "image", ...image }]),
      ],
      isError,
    }),
  );
};

/**
 * Each Thread's dx tools as DxAgent mounted them for the current submission:
 * the list the dx MCP server offers, and the tools a subagent's calls run,
 * since Flue never sees a subagent's calls.
 */
const threadTools = new Map<string, ReadonlyArray<ToolDefinition>>();

interface CallContext {
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
  readonly log: FlueLogger;
  readonly harness: FlueHarness;
}

type Outcome =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly image: ReturnType<typeof takeImage>;
    }
  | { readonly ok: false; readonly error: unknown };

/** The text Claude gets for a call that failed. */
const failureText = (name: string, error: unknown, signal?: AbortSignal) =>
  signal?.aborted
    ? "Stopped."
    : error instanceof Error && error.message !== ""
      ? error.message
      : `${name} failed.`;

/** Validates Claude's arguments and runs the tool. */
const perform = async (
  tool: ToolDefinition,
  args: unknown,
  context: CallContext,
): Promise<Outcome> => {
  try {
    if (
      typeof args === "object" &&
      args !== null &&
      UNREADABLE_TOOL_INPUT in args
    )
      throw new Error(
        `dx could not read the input of this ${tool.name} call, so the tool did not run: it was not a complete JSON object. Call ${tool.name} again.`,
      );
    let data = args;
    if (tool.input !== undefined) {
      const parsed = v.safeParse(tool.input, args);
      if (!parsed.success)
        throw new Error(
          `Invalid arguments for ${tool.name}: ${v.summarize(parsed.issues)}`,
        );
      data = parsed.output;
    }
    if (tool.durable === true)
      throw new Error(`${tool.name} cannot run outside dx's own tool loop.`);
    const result = await tool.run({ ...context, data } as never);
    return { ok: true, result, image: takeImage(context.toolCallId) };
  } catch (error) {
    takeImage(context.toolCallId);
    return { ok: false, error };
  }
};

/**
 * Validates Claude's arguments and runs the tool, then hands the result to
 * the waiting server. Every call gets an answer, a rejected one included:
 * Claude waits on the server until it does.
 */
const execute = async (
  tool: ToolDefinition,
  args: unknown,
  context: CallContext,
) => {
  const sandbox = context.harness.sandbox as Sandbox;
  const outcome = await perform(tool, args, context);
  if (!outcome.ok) {
    await answer(
      sandbox,
      context.toolCallId,
      failureText(tool.name, outcome.error, context.signal),
      true,
    ).catch(() => undefined);
    throw outcome.error;
  }
  const { result, image } = outcome;
  await answer(sandbox, context.toolCallId, resultText(result), false, image);
  return { result, image };
};

/**
 * Read-only dx tools. Flue runs a durable tool again when a restarted
 * submission finds its call unfinished, and records the real result in place
 * of "interrupted, outcome unknown"; the rerun answers the same call Claude
 * still waits on. Running one of these again only reads the current state;
 * a call that changes something is never repeated.
 */
const RERUNNABLE: ReadonlySet<string> = new Set([
  "wait_for_threads",
  "get_thread_status",
  "read_thread",
  "find_thread",
  "list_orbs",
  "list_agent_modes",
  "list_bug_reports",
  "read_bug_report",
  // The inbox tools only read (list_emails may make the Thread's alias,
  // which a second run finds made).
  "list_emails",
  "read_email",
  "wait_for_email",
]);

/**
 * Runs a dx tool for Claude's call, as Flue reaches it. Claude waits on
 * this call, and in a batch of only dx tools no mirror reads the run
 * meanwhile; reading it keeps writing the run's keep-alive, so the
 * workspace does not sleep under Claude.
 */
const runForClaude = async (
  threadId: string,
  tool: ToolDefinition,
  context: CallContext & { readonly data: unknown },
) => {
  const watching = new AbortController();
  const watched = claudeCodeRuns
    .forToolCall(
      threadId,
      context.toolCallId,
      context.harness.sandbox as Sandbox,
      watching.signal,
    )
    .then((run) => run?.waitFor(() => false, watching.signal))
    .catch(() => undefined);
  try {
    return await execute(tool, context.data, context);
  } catch (error) {
    // Stop during a batch of only dx tools must also stop Claude,
    // which no mirror is waiting on to stop it.
    if (context.signal?.aborted) {
      const run = await claudeCodeRuns
        .forToolCall(
          threadId,
          context.toolCallId,
          context.harness.sandbox as Sandbox,
        )
        .catch(() => undefined);
      await run?.stop();
    }
    throw error;
  } finally {
    watching.abort();
    await watched;
  }
};

/**
 * dx's own tools for a Claude Code Thread, under the names dx's own loop
 * uses. Claude calls them through the dx tool bridge beside the CLI; Flue
 * runs the real tool when it reaches the call, exactly as for any other
 * model, so metering, Stop, and the transcript are dx's. Flue accepts any
 * arguments, so a call it would reject still reaches the tool, which
 * answers with the error.
 */
export const claudeCodeDxTools = (
  threadId: string,
  tools: ReadonlyArray<ToolDefinition>,
): ToolDefinition[] => {
  for (const tool of tools)
    if (!isClaudeCodeDxTool(tool.name) || tool.name.startsWith("mcp__"))
      throw new Error(
        `The dx tool ${tool.name} cannot reach Claude Code: dx tool names are snake_case, so they never clash with Claude's own tools.`,
      );
  threadTools.set(threadId, tools);
  return tools.map(
    (tool) =>
      ({
        ...tool,
        name: tool.name,
        input: v.looseObject({}),
        harness: true,
        durable: RERUNNABLE.has(tool.name),
        run: async (context: CallContext & { readonly data: unknown }) =>
          (await runForClaude(threadId, tool, context)).result,
      }) as ToolDefinition,
  );
};

type AgentTool = ReturnType<SandboxToolFactory>[number];

/** Logs nothing; the tools that show images do not log. */
const silent: FlueLogger = { info() {}, warn() {}, error() {} };

/**
 * A dx tool that shows Claude an image, as a sandbox tool: only those can
 * record an image block, which Flue stores as an attachment of the
 * conversation, so the transcript shows the image Claude saw beside the
 * text. `claudeCodeDxTools` must list the tool too, for the MCP server.
 */
export const claudeCodeDxSandboxTool = (
  threadId: string,
  tool: ToolDefinition,
  sandbox: Sandbox,
): AgentTool => ({
  name: tool.name,
  label: tool.name,
  description: tool.description,
  parameters: Type.Unsafe<Record<string, unknown>>({ type: "object" }),
  async execute(toolCallId, data, signal) {
    const { result, image } = await runForClaude(threadId, tool, {
      toolCallId,
      data,
      ...(signal === undefined ? {} : { signal }),
      log: silent,
      harness: { sandbox } as FlueHarness,
    });
    return {
      content: [
        { type: "text" as const, text: resultText(result) },
        ...(image === undefined ? [] : [{ type: "image" as const, ...image }]),
      ],
      details: {},
    };
  },
});

/** The Claude Code run a subagent's dx call answers through. */
export interface ClaudeCodeSubagentWorkspace {
  /** The run reader's handle, which replaces one that stopped answering. */
  readonly sandbox: Sandbox;
  reconnectSandbox(): Promise<Sandbox>;
}

/** Writes of one answer before dx gives up on handing it over. */
const SUBAGENT_ANSWER_ATTEMPTS = 3;
/** A write that has not finished by then counts as failed. */
const SUBAGENT_ANSWER_WRITE_MS = 30_000;

const withinAnswerDeadline = <A>(write: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    write,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("the workspace did not finish the write")),
        SUBAGENT_ANSWER_WRITE_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * A dx tool call one of Claude's subagents made. It never reaches a Flue
 * segment, so the Agent call that started the subagent runs it, through the
 * run's own workspace handle: the Agent call's handle may have stopped
 * answering while the run's reader replaced its own (#2282). The answer is
 * written again on a new handle when a write fails. When it still cannot be
 * written this throws: the bridge would otherwise hold the subagent for 30
 * minutes on a call dx already finished.
 */
export const runClaudeCodeSubagentDxCall = async (
  threadId: string,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
  context: Omit<CallContext, "toolCallId"> & {
    readonly workspace: ClaudeCodeSubagentWorkspace;
  },
) => {
  const { workspace, ...rest } = context;
  const tool = threadTools
    .get(threadId)
    ?.find(({ name }) => name === dxToolName(call.name));
  const outcome: Outcome =
    tool === undefined
      ? {
          ok: false,
          error: new Error(`${call.name} is not available in this Thread.`),
        }
      : await perform(tool, call.input, {
          ...rest,
          toolCallId: call.id,
          // The harness keeps its methods; only its workspace changes.
          harness: Object.create(rest.harness, {
            sandbox: { value: workspace.sandbox },
          }) as FlueHarness,
        });
  const [text, isError, image] = outcome.ok
    ? [resultText(outcome.result), false, outcome.image]
    : [failureText(call.name, outcome.error, rest.signal), true, undefined];
  let failure: unknown;
  for (let attempt = 0; attempt < SUBAGENT_ANSWER_ATTEMPTS; attempt += 1) {
    if (rest.signal?.aborted) return;
    const sandbox =
      attempt === 0 ? workspace.sandbox : await workspace.reconnectSandbox();
    try {
      await withinAnswerDeadline(
        answer(sandbox, call.id, text, isError, image),
      );
      return;
    } catch (error) {
      failure = error;
    }
  }
  const cause =
    failure instanceof Error
      ? failure.message || failure.name
      : String(failure);
  claudeCodeLogger.error(
    "dx could not answer a Claude Code subagent's dx call.",
    {
      event: "claude_code_subagent_answer_lost",
      threadId,
      tool: call.name,
      toolCallId: call.id,
      detail: cause.slice(0, 500),
    },
  );
  throw new Error(
    `dx could not return the result of ${call.name} to Claude Code's subagent (${cause}), so it stopped Claude Code instead of leaving the subagent waiting on it.`,
  );
};

/** The Thread's dx tools as the dx tool bridge lists them. */
export const claudeCodeDxToolList = (threadId: string): ClaudeCodeDxTool[] =>
  (threadTools.get(threadId) ?? []).map((tool) => {
    const schema =
      tool.input === undefined
        ? { type: "object", properties: {} }
        : (({ $schema: _, ...rest }) => rest)(
            toJsonSchema(tool.input, { errorMode: "ignore" }),
          );
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: schema,
    };
  });

/**
 * Flue answers a call naming a tool the model call did not offer without
 * running anything ("Tool <name> not found"). Claude waits on a dx call's
 * server, and may hold the rest of its batch until it answers, while Flue
 * finishes the batch, and so makes the next model call, only once the
 * batch's mirrors have Claude's results. So such a dx call is answered as
 * its segment closes, as Flue will answer it.
 */
export const answerUnofferedClaudeCodeDxCalls = async (
  calls: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  context: Context,
  sandbox: Sandbox,
) => {
  // pi carries the offered tools as transcript messages, like the prompt.
  const offered = new Set(
    getCurrentTools(context.messages).map(({ name }) => name),
  );
  for (const call of calls)
    if (isClaudeCodeDxTool(call.name) && !offered.has(call.name))
      await answer(sandbox, call.id, `Tool ${call.name} not found`, true);
};

/**
 * A dx tool call Flue settled without running the tool, such as one a
 * restart interrupted, wrote no result; the next model call hands Flue's
 * recorded result to the waiting server.
 */
export const deliverClaudeCodeDxToolResults = async (
  context: Context,
  sandbox: Sandbox,
) => {
  const lastAssistant = context.messages.findLastIndex(
    ({ role }) => role === "assistant",
  );
  for (const message of context.messages.slice(lastAssistant + 1)) {
    if (message.role !== "toolResult" || !isClaudeCodeDxTool(message.toolName))
      continue;
    if (await sandbox.exists(claudeCodeToolResultPath(message.toolCallId)))
      continue;
    await answer(
      sandbox,
      message.toolCallId,
      message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n") || `${message.toolName} failed.`,
      message.isError,
    );
  }
};
