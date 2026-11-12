import { mcpAppCardSetId } from "@dx/api/views/mcp-app-note.mjs";
import type { ToolPart } from "./transcript-activity-projection.js";

/**
 * The card set a `code_exec` call showed, from the note core ends its
 * output with once it saved them. Claude Code mode hands the output over as
 * text blocks.
 */
export const mcpAppCardSet = (part: ToolPart) => {
  if (part.toolName !== "code_exec" || part.state !== "output-available")
    return undefined;
  const output: unknown = part.output;
  const text =
    typeof output === "string"
      ? output
      : Array.isArray(output)
        ? output
            .map((block: unknown) =>
              typeof block === "object" &&
              block !== null &&
              typeof (block as { text?: unknown }).text === "string"
                ? (block as { text: string }).text
                : "",
            )
            .join("\n")
        : "";
  return mcpAppCardSetId(text);
};

export const isMcpAppPart = (part: ToolPart) =>
  mcpAppCardSet(part) !== undefined;
