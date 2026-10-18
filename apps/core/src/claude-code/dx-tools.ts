import type { Context } from "@earendil-works/pi-ai";
import type {
  FlueHarness,
  FlueLogger,
  Sandbox,
  ToolDefinition,
} from "@flue/runtime";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { claudeCodeRuns } from "./runs.js";
import {
  type ClaudeCodeDxTool,
  claudeCodeToolResultPath,
} from "./workspace-run.js";

/** Claude Code names a tool of the `dx` MCP server `mcp__dx__<name>`. */
export const CLAUDE_CODE_DX_TOOL_PREFIX = "mcp__dx__";

export const isClaudeCodeDxTool = (name: string) =>
  name.startsWith(CLAUDE_CODE_DX_TOOL_PREFIX);

/** The text Claude receives: what the model would see for this result. */
const resultText = (result: unknown) => {
  if (typeof result === "string") return result;
  const output =
    result !== null && typeof result === "object" && "output" in result
      ? result.output
      : result;
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
};

const answer = async (
  sandbox: Sandbox,
  toolCallId: string,
  text: string,
  isError: boolean,
) => {
  // A sandbox write creates missing parent directories.
  await sandbox.writeFile(
    claudeCodeToolResultPath(toolCallId),
    JSON.stringify({ content: [{ type: "text", text }], isError }),
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
  let result: unknown;
  try {
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
    result = await tool.run({ ...context, data } as never);
  } catch (error) {
    await answer(
      sandbox,
      context.toolCallId,
      context.signal?.aborted
        ? "Stopped."
        : error instanceof Error && error.message !== ""
          ? error.message
          : `${tool.name} failed.`,
      true,
    ).catch(() => undefined);
    throw error;
  }
  await answer(sandbox, context.toolCallId, resultText(result), false);
  return result;
};

/**
 * dx's own tools for a Claude Code Thread. Claude calls them through the
 * `dx` MCP server in the workspace; Flue runs the real tool when it reaches
 * the call, exactly as for any other model, so metering, Stop, and the
 * transcript are dx's. Flue accepts any arguments, so a call it would
 * reject still reaches the tool, which answers with the error.
 */
export const claudeCodeDxTools = (
  threadId: string,
  tools: ReadonlyArray<ToolDefinition>,
): ToolDefinition[] => {
  threadTools.set(threadId, tools);
  return tools.map(
    (tool) =>
      ({
        ...tool,
        name: `${CLAUDE_CODE_DX_TOOL_PREFIX}${tool.name}`,
        input: v.looseObject({}),
        harness: true,
        run: async (context: CallContext & { readonly data: unknown }) => {
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
          }
        },
      }) as ToolDefinition,
  );
};

/**
 * A dx tool call one of Claude's subagents made. It never reaches a Flue
 * segment, so the Agent call that started the subagent runs it.
 */
export const runClaudeCodeSubagentDxCall = async (
  threadId: string,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
  context: Omit<CallContext, "toolCallId">,
) => {
  const tool = threadTools
    .get(threadId)
    ?.find(({ name }) => `${CLAUDE_CODE_DX_TOOL_PREFIX}${name}` === call.name);
  if (tool === undefined) {
    await answer(
      context.harness.sandbox as Sandbox,
      call.id,
      `${call.name} is not available in this Thread.`,
      true,
    );
    return;
  }
  await execute(tool, call.input, { ...context, toolCallId: call.id }).catch(
    () => undefined,
  );
};

/** The Thread's dx tools as the `dx` MCP server lists them. */
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
 * A dx tool call Flue settled without running the tool, such as one naming
 * a tool this submission no longer offers, wrote no result; the next model
 * call hands Flue's recorded result to the waiting server.
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
