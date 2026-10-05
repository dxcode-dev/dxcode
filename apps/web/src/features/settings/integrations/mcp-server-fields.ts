import type { McpServerData } from "./mcp-queries.js";

/** The timeout new servers get; the API accepts 1–30 s. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `secret` is only shown for servers created before tokens were stored on
 * the server: their token is an environment-variable secret, which is also
 * visible in Thread sandboxes.
 */
export type McpAuthMode = "none" | "token" | "secret";

export interface McpServerFields {
  readonly name: string;
  readonly endpoint: string;
  readonly auth: McpAuthMode;
  /** A new token; empty keeps a stored one. */
  readonly token: string;
}

export const mcpFieldsFor = (server: McpServerData): McpServerFields => ({
  name: server.name,
  endpoint: server.endpoint,
  auth: server.hasStoredToken
    ? "token"
    : server.authReference === undefined
      ? "none"
      : "secret",
  token: "",
});

/** Whether the fields can be saved: a new token-auth server needs a token. */
export const mcpFieldsComplete = (
  fields: McpServerFields,
  server?: McpServerData,
) =>
  fields.auth !== "token" ||
  fields.token.trim().length > 0 ||
  server?.hasStoredToken === true;

/** New servers keep the API defaults: all projects, all roles. */
export const mcpCreateInput = (fields: McpServerFields) => ({
  name: fields.name.trim(),
  endpoint: fields.endpoint.trim(),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  ...(fields.auth === "token" ? { authToken: fields.token.trim() } : {}),
});

/**
 * Edits leave timeout and grants untouched. A typed token sets or rotates
 * the stored one; choosing no token clears whatever auth the server had.
 */
export const mcpUpdateInput = (
  fields: McpServerFields,
  server: McpServerData,
) => ({
  name: fields.name.trim(),
  endpoint: fields.endpoint.trim(),
  ...(fields.auth === "token" && fields.token.trim().length > 0
    ? { authToken: fields.token.trim() }
    : fields.auth === "none" &&
        (server.hasStoredToken || server.authReference !== undefined)
      ? { authReference: null }
      : {}),
});

/** A few words beside the name, only when the server needs attention. */
export const mcpServerHint = (server: McpServerData): string | undefined => {
  if (server.healthStatus === "unhealthy") return "Unreachable";
  if (server.tools.length === 0) return "Tools not discovered";
  const pending = server.tools.filter((tool) => !tool.approved).length;
  if (pending > 0)
    return `${pending} ${pending === 1 ? "tool" : "tools"} to review`;
  return undefined;
};
