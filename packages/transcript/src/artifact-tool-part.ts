import type { ToolPart } from "./transcript-activity-projection.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** The agent's `artifact` tool, as the transcript names it in both modes. */
export const ARTIFACT_TOOL_NAME = "artifact";

export const artifactAction = (part: ToolPart) => {
  const action = record(part.input)?.action;
  return typeof action === "string" ? action : undefined;
};

/** A dx tool's result; Claude Code mode hands it over as JSON text. */
export const artifactOutput = (
  part: ToolPart,
): Record<string, unknown> | undefined => {
  if (typeof part.output !== "string") return record(part.output);
  try {
    return record(JSON.parse(part.output));
  } catch {
    return undefined;
  }
};

/** Whether this call gets its own card: a create, update, or delete. */
export const isArtifactCardPart = (part: ToolPart) =>
  part.toolName === ARTIFACT_TOOL_NAME &&
  ["create", "update", "delete"].includes(artifactAction(part) ?? "");
