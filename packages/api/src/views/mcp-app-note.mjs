// The note `code_exec` ends its output with when a call showed MCP Apps
// cards. Plain JavaScript with no imports, so the transcript can find card
// sets without loading the API schemas.

/**
 * MCP Apps (the `io.modelcontextprotocol/ui` extension): a tool that names a
 * `ui://` resource in `_meta.ui.resourceUri` gets that HTML shown as a card
 * in its tool row. MCP tools reach the model through `code_exec`, so its
 * output ends with this note when a call produced cards, which tells the
 * model the person saw them and names the call's card set for the
 * transcript: `[MCP App shown to the person: <server tool, …> (mcpa_…)]`.
 * The id is dx's own; providers may repeat tool call ids across turns.
 */
export const MCP_APP_OUTPUT_NOTE = "[MCP App shown to the person:";

/**
 * The card set an output's note names, if any.
 *
 * @param {string} output
 */
export const mcpAppCardSetId = (output) => {
  for (const line of output.split("\n"))
    if (line.startsWith(MCP_APP_OUTPUT_NOTE)) {
      const id = /\((mcpa_[0-9a-f]{32})\)\]$/.exec(line)?.[1];
      if (id !== undefined) return id;
    }
  return undefined;
};
