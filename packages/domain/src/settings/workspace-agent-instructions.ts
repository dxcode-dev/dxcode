import { Schema } from "effect";

/**
 * A workspace's AGENTS.md: guidance an admin gives every member's top-level
 * agent, ahead of the member's own instructions and the project's AGENTS.md.
 */
export const MAX_WORKSPACE_AGENT_INSTRUCTIONS_LENGTH = 8_000;

export const WorkspaceAgentInstructionsContent = Schema.String.check(
  Schema.isMaxLength(MAX_WORKSPACE_AGENT_INSTRUCTIONS_LENGTH),
);

export type WorkspaceAgentInstructionsContent =
  typeof WorkspaceAgentInstructionsContent.Type;
