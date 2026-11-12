/**
 * Claude Code's own tools (Bash, Edit, Write, …) run inside the CLI, so dx's
 * tool wrappers never see them before they run. When installed plugins gate
 * tool calls, the dx tool bridge registers a PreToolUse hook with the CLI:
 *
 * 1. Claude Code asks the bridge about each call before running it. The
 *    bridge prints the request as a `dx_hook` line on the run's output and
 *    waits for `mcp/hooks/<tool_use id>.json`.
 * 2. dx reads the line with the rest of the run's output and asks the
 *    Thread's gate, the plugins' `tool.call` handlers, then writes the
 *    decision there.
 * 3. The bridge answers the hook: allow (with any modified input) or deny
 *    with the plugin's message, which Claude reads as the tool's result.
 *
 * The bridge denies a call when no decision arrives in time, so the gate
 * fails closed in Claude Code mode as in dx mode.
 */

export interface ClaudeCodeHookRequest {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export type ClaudeCodeHookDecision =
  | {
      readonly decision: "allow";
      readonly input?: Record<string, unknown>;
    }
  | { readonly decision: "deny"; readonly reason: string };

export type ClaudeCodeToolGate = (
  request: ClaudeCodeHookRequest,
) => Promise<ClaudeCodeHookDecision>;

/** The line type the bridge prints for each hook request. */
export const CLAUDE_CODE_HOOK_LINE = "dx_hook";

/**
 * Seconds the bridge waits for dx's decision before it denies the call. A
 * plugin's tool.call handler may wait on a person's answer for up to 30
 * minutes, so this covers that plus a margin; a handler that does not wait
 * on a person still times out in 10 seconds inside dx.
 */
export const CLAUDE_CODE_HOOK_WAIT_SECONDS = 1_860;

const gates = new Map<string, ClaudeCodeToolGate>();

/** Sets, or with undefined clears, the Thread's gate for this submission. */
export const setClaudeCodeToolGate = (
  threadId: string,
  gate: ClaudeCodeToolGate | undefined,
) => {
  if (gate === undefined) gates.delete(threadId);
  else gates.set(threadId, gate);
};

export const claudeCodeToolGate = (threadId: string) => gates.get(threadId);
