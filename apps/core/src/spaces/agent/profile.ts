import type { ToolDefinition } from "@flue/runtime";
import {
  buildSpaceSystemPrompt,
  type SpaceSystemPromptInput,
} from "./system-prompt.js";

/**
 * The Space agent profile: what a Space's main thread runs with, whichever
 * runtime runs it. The dx agent (Flue) consumes it today; a Claude Code
 * Space consumes the same profile:
 *
 * - `prompt` is the dx agent's whole system prompt; Claude Code appends
 *   the same text to its own (`--append-system-prompt-file`, as for every
 *   Claude Code Thread);
 * - `tools` is the whole dx tool set, which Claude Code reaches through the
 *   dx tool bridge under the same names (`claudeCodeDxTools`);
 * - `orb` is `none`: no sandbox, so no shell, file, or Git tool, and
 *   `claudeCodeBuiltInTools` is all Claude Code may keep of its own.
 */
export interface SpaceAgentProfile {
  readonly prompt: string;
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly orb: "none";
  readonly claudeCodeBuiltInTools: ReadonlyArray<string>;
}

/**
 * The dx tools a Space's main thread keeps besides its own. Left out on
 * purpose: tools that write into or read from the caller's own Orb
 * (`view_media`, `download_thread_changes`, `download_thread_file`,
 * `upload_thread_file`), `wait_for_threads` (a Space ends its turn and
 * hears reports), GitHub subscriptions and links, `request_attention` (a
 * Space asks with `set_thread_status` and a post), and installed plugins,
 * which run in an Orb.
 */
export const SPACE_KEPT_DX_TOOLS: ReadonlySet<string> = new Set([
  "create_thread",
  "send_thread_message",
  "get_thread_status",
  "find_thread",
  "read_thread",
  "update_thread",
  "thread_file_url",
  "artifact",
  "set_schedule",
  "get_schedule",
  "update_schedule",
  "clear_schedule",
  "notify_user",
  "code_exec",
  "tool_search",
  "list_agent_modes",
  "list_orbs",
  "list_bug_reports",
  "read_bug_report",
  "web_search",
  "read_web_page",
]);

/**
 * Claude Code keeps its own system prompt, written for a coding assistant
 * that answers in its reply, and the Space's prompt is appended after it
 * (`--append-system-prompt-file`). This opening says which one decides how
 * the agent works in a Space.
 */
export const SPACE_CLAUDE_CODE_PREFACE =
  "# You are this Space's agent\n\nThe instructions below decide how you work in this session. Where the Claude Code instructions above differ, such as answering in your reply or working on files yourself, follow the instructions below: people see only your posts, and threads do the work.";

/** Claude Code's own tools a Space may keep: the web, nothing local. */
export const SPACE_CLAUDE_CODE_BUILT_IN_TOOLS = ["WebSearch", "WebFetch"];

/** The Space's tool set: its own tools, then the dx tools it keeps. */
export const spaceProfileTools = (
  spaceTools: ReadonlyArray<ToolDefinition>,
  dxTools: ReadonlyArray<ToolDefinition>,
): ToolDefinition[] => [
  ...spaceTools,
  ...dxTools.filter(({ name }) => SPACE_KEPT_DX_TOOLS.has(name)),
];

/**
 * The Space's whole system prompt: the Space prompt, then the workspace's
 * and owner's instructions (`settingsInstructions`), framed as ordinary
 * Threads frame them.
 */
export const spaceAgentProfile = (input: {
  readonly space: SpaceSystemPromptInput;
  readonly instructions: string;
  readonly tools: ReadonlyArray<ToolDefinition>;
}): SpaceAgentProfile => ({
  prompt: [buildSpaceSystemPrompt(input.space), input.instructions]
    .filter((part) => part.length > 0)
    .join("\n\n"),
  tools: input.tools,
  orb: "none",
  claudeCodeBuiltInTools: SPACE_CLAUDE_CODE_BUILT_IN_TOOLS,
});
