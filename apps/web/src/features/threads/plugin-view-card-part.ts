import type { ToolPart } from "@dx/client";

const VIEW_KEY = "dev.dxcode/view";

/**
 * The view a plugin tool's result asks to show as a card under its row:
 * `{ "_meta": { "dev.dxcode/view": "dashboard" } }`, as MCP Apps name a
 * `ui://` view. dx's agent hands plugin results over as JSON text. The card
 * draws only a view the tool's plugin shows as a card, so anything else
 * here draws nothing.
 */
export const pluginViewCardOf = (part: ToolPart): string | undefined => {
  const output = part.state === "output-available" ? part.output : undefined;
  if (typeof output !== "string" || !output.includes(VIEW_KEY)) return;
  try {
    return JSON.parse(output)._meta[VIEW_KEY];
  } catch {}
};
