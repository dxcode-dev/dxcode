/** What an MCP server's OAuth callback reported, once Core sent the browser back. */
export interface McpOAuthReturn {
  readonly serverId: string | undefined;
  readonly connected: boolean;
  readonly message: string | undefined;
}

const RETURN_PARAMS = ["mcp", "mcpStatus", "mcpMessage"] as const;
let pending: McpOAuthReturn | undefined;

/**
 * The integrations routes' `beforeLoad`: Core's OAuth callback lands on
 * `?mcp=…&mcpStatus=…&mcpMessage=…`. This keeps what it reported for the
 * page and returns the same page's address without those parameters, for
 * the route to redirect to, so a reload or a copied link does not report
 * it again. Undefined when the address carries no report.
 */
export const takeMcpOAuthReturn = (
  location: {
    readonly pathname: string;
    readonly searchStr: string;
    readonly hash: string;
  },
  preload: boolean,
): string | undefined => {
  if (preload) return undefined;
  const params = new URLSearchParams(location.searchStr);
  const status = params.get("mcpStatus");
  if (status === null) return undefined;
  pending = {
    serverId: params.get("mcp") ?? undefined,
    connected: status === "connected",
    message: params.get("mcpMessage") ?? undefined,
  };
  for (const name of RETURN_PARAMS) params.delete(name);
  const search = params.toString();
  return `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash === "" ? "" : `#${location.hash}`}`;
};

/** What the last OAuth callback reported, while its page stays open. */
export const mcpOAuthReturn = () => pending;

/** The integrations routes' `onLeave`: the report belongs to that visit. */
export const forgetMcpOAuthReturn = () => {
  pending = undefined;
};
