import type { ThinkingLevel } from "./model-routing.js";

/**
 * Claude Code mode: a Thread whose agent loop is the Claude Code CLI running
 * in the Thread's workspace on the owner's Claude Pro/Max plan. A personal
 * model connection with this provider id stores the `claude setup-token`
 * OAuth token; a Thread pins `claude-code/<model>` with an effort.
 */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

export interface ClaudeCodeModel {
  readonly id: string;
  readonly name: string;
}

/** Models a Claude Pro/Max plan serves to Claude Code, newest first. */
export const CLAUDE_CODE_MODELS: ReadonlyArray<ClaudeCodeModel> = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
];

export const CLAUDE_CODE_DEFAULT_MODEL = `${CLAUDE_CODE_PROVIDER_ID}/claude-opus-5-5`;

/** The `--effort` levels Claude Code accepts. */
export const CLAUDE_CODE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<ThinkingLevel>;

export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

export const CLAUDE_CODE_DEFAULT_EFFORT: ClaudeCodeEffort = "high";

export const isClaudeCodeModel = (canonical: string): boolean =>
  canonical.startsWith(`${CLAUDE_CODE_PROVIDER_ID}/`);

/** The effort Claude Code runs at for a Thread's thinking level. */
export const claudeCodeEffort = (thinking: ThinkingLevel): ClaudeCodeEffort =>
  thinking === "off" || thinking === "minimal"
    ? "low"
    : (thinking as ClaudeCodeEffort);
