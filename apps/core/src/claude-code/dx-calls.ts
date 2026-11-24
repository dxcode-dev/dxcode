import type { Sandbox } from "@flue/runtime";

/**
 * Every dx tool call Claude Code makes reaches the dx tool bridge
 * (tool-bridge.ts) as an MCP `tools/call`, from the main agent and from a
 * subagent at any depth. Claude prints a subagent's messages only for
 * subagents the main agent started, and none for a subagent's own
 * subagents, so the run's output alone cannot show dx every call. The bridge
 * therefore prints each call as a `dx_tool_call` line:
 *
 * - Flue runs the main agent's calls from their segments, as for any model.
 * - The run's reader answers every other call (workspace-run.ts), whoever
 *   is reading the run: the model stream or a waiting tool, also after a
 *   restart lost the Agent call that started the subagent.
 *
 * While dx runs a call it rewrites `mcp/results/<id>.alive` every
 * `CLAUDE_CODE_DX_CALL_BEAT_SECONDS`. The bridge fails a call dx never
 * started, or stopped beating for, within minutes, instead of holding
 * Claude for the full wait a slow call may need.
 */
export interface ClaudeCodeDxCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** The line type the bridge prints for each dx tool call. */
export const CLAUDE_CODE_DX_CALL_LINE = "dx_tool_call";

/** How often dx marks a call it runs as alive. */
export const CLAUDE_CODE_DX_CALL_BEAT_SECONDS = 15;

/**
 * How long the bridge waits for dx to start a call. Flue starts the main
 * agent's calls once their segment ends, and the reader starts a
 * subagent's on its next read, both within seconds.
 */
export const CLAUDE_CODE_DX_CALL_PICKUP_SECONDS = 120;

/** How long a started call may go without a beat before the bridge fails it. */
export const CLAUDE_CODE_DX_CALL_STALE_SECONDS = 90;

/**
 * The longest any one call may run. Some dx tools wait on purpose:
 * `manage_dx` waits up to 10 minutes on the owner's card, `wait_for_threads`
 * and `wait_for_email` up to 5. Claude Code's own MCP tool timeout is a
 * minute longer (workspace-run.ts).
 */
export const CLAUDE_CODE_DX_CALL_WAIT_SECONDS = 30 * 60;

/** Answers a subagent's dx call through the run's workspace handle. */
export type ClaudeCodeDxCallServer = (
  call: ClaudeCodeDxCall,
  workspace: {
    readonly sandbox: Sandbox;
    reconnectSandbox(): Promise<Sandbox>;
  },
  signal: AbortSignal,
) => Promise<void>;

const servers = new Map<string, ClaudeCodeDxCallServer>();

/** Sets the Thread's server for this submission's dx tools. */
export const setClaudeCodeDxCallServer = (
  threadId: string,
  server: ClaudeCodeDxCallServer,
) => {
  servers.set(threadId, server);
};

export const claudeCodeDxCallServer = (threadId: string) =>
  servers.get(threadId);
