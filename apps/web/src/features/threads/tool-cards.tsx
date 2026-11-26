import { McpAppCards } from "./mcp-app-cards.js";
import { PluginViewCard } from "./plugin-view-card.js";

/**
 * The cards under a tool row, loaded with the first call that has any: a
 * `code_exec` call's MCP App cards, or the view a plugin tool's result
 * named. One lazy module for both keeps the transcript's first load small.
 */
export function ToolCards(
  props:
    | { readonly cardSetId: string }
    | { readonly toolName: string; readonly view: string },
) {
  return "cardSetId" in props ? (
    <McpAppCards cardSetId={props.cardSetId} />
  ) : (
    <PluginViewCard toolName={props.toolName} view={props.view} />
  );
}
