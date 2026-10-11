import { defineTool, type Sandbox, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { isClaudeCodeDxTool, runClaudeCodeSubagentDxCall } from "./dx-tools.js";
import { claudeCodeRuns } from "./runs.js";
import type { ClaudeCodeRun } from "./workspace-run.js";

/**
 * Flue records every tool call it executes, so each Claude Code tool call
 * becomes a Flue call to a mirror tool of the same name. The mirror runs
 * nothing: Claude already ran the tool, and the mirror returns the result
 * Claude recorded. History and the transcript therefore show Claude's real
 * calls with their real inputs and outputs.
 */
export const CLAUDE_CODE_MIRROR_TOOLS = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Bash",
  "BashOutput",
  "KillShell",
  "Monitor",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Skill",
  "ToolSearch",
  "Workflow",
  "ReportFindings",
  "EnterWorktree",
  "ExitWorktree",
  "SlashCommand",
] as const;

/**
 * Any other Claude tool (a project MCP server, a newer built-in) arrives
 * under this name.
 */
export const CLAUDE_CODE_OTHER_TOOL = "ClaudeCodeTool";

const MIRRORED: ReadonlySet<string> = new Set(CLAUDE_CODE_MIRROR_TOOLS);

/** Flue's name and arguments for a call Claude made. */
export const mirroredToolCall = (
  name: string,
  input: Record<string, unknown>,
): { readonly name: string; readonly arguments: Record<string, unknown> } =>
  // A dx tool keeps its name: Flue runs the real tool, not a mirror.
  MIRRORED.has(name) || isClaudeCodeDxTool(name)
    ? { name, arguments: input }
    : { name: CLAUDE_CODE_OTHER_TOOL, arguments: { tool: name, input } };

/** Claude Code tools that run a subagent. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** Tools whose result may have changed the workspace. */
const MUTATING = new Set([
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "Task",
  "Agent",
  "Workflow",
  CLAUDE_CODE_OTHER_TOOL,
]);

/** dx tool calls a subagent made that still wait for an answer. */
const pendingSubagentDxCalls = (
  run: ClaudeCodeRun,
  toolCallId: string,
  answered: ReadonlySet<string>,
) =>
  (run.stream.subagents.get(toolCallId) ?? []).flatMap((step) =>
    step.type === "tool" &&
    isClaudeCodeDxTool(step.name) &&
    step.output === undefined &&
    !answered.has(step.id)
      ? [step]
      : [],
  );

const definition = (threadId: string, name: string) =>
  defineTool({
    name,
    description: `Claude Code's ${name} tool. Claude Code runs it in the workspace.`,
    input: v.looseObject({}),
    harness: true,
    async run({ toolCallId, signal, harness, log }) {
      const sandbox = harness.sandbox as Sandbox;
      const run = await claudeCodeRuns.forToolCall(
        threadId,
        toolCallId,
        sandbox,
        signal,
      );
      if (run === undefined)
        throw new Error(
          `Claude Code has no record of ${name} call ${toolCallId}.`,
        );
      try {
        // A subagent's dx tool calls never reach a Flue segment; the Agent
        // call that waits on the subagent runs them.
        const answered = new Set<string>();
        for (;;) {
          await run.waitFor(
            () =>
              run.stream.toolResults.has(toolCallId) ||
              (SUBAGENT_TOOLS.has(name) &&
                pendingSubagentDxCalls(run, toolCallId, answered).length > 0),
            signal,
          );
          if (run.stream.toolResults.has(toolCallId)) break;
          const calls = SUBAGENT_TOOLS.has(name)
            ? pendingSubagentDxCalls(run, toolCallId, answered)
            : [];
          if (calls.length === 0) break;
          for (const call of calls) {
            answered.add(call.id);
            await runClaudeCodeSubagentDxCall(threadId, call, {
              ...(signal === undefined ? {} : { signal }),
              log,
              harness,
            });
          }
        }
      } catch (error) {
        // Stop while Claude runs a tool ends the CLI run, not only the wait.
        if (signal?.aborted) await run.stop();
        throw error;
      }
      const result = run.stream.toolResults.get(toolCallId);
      if (MUTATING.has(name)) await run.syncChanges();
      if (result === undefined)
        throw new Error(`Claude Code ended before ${name} returned a result.`);
      if (result.isError) throw new Error(result.text || `${name} failed.`);
      // A subagent's call records the subagent: its report and its steps.
      if (SUBAGENT_TOOLS.has(name) && result.subagent !== undefined)
        return {
          // Steps hold Claude's tool inputs; JSON is what Flue records.
          output: JSON.parse(
            JSON.stringify({
              ...result.subagent,
              steps: run.stream.subagents.get(toolCallId) ?? [],
            }),
          ),
        };
      return result.text;
    },
  });

export const claudeCodeMirrorTools = (
  threadId: string,
): ReadonlyArray<ToolDefinition> =>
  [...CLAUDE_CODE_MIRROR_TOOLS, CLAUDE_CODE_OTHER_TOOL].map(
    (name) => definition(threadId, name) as ToolDefinition,
  );
