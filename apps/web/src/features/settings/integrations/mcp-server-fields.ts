import { ApiError, type McpServerInput } from "../../../shared/api/client.js";
import { MCP_TEMPLATES, type McpTemplate } from "./mcp-catalog.js";
import type { McpServerData } from "./mcp-queries.js";

/** The timeout new servers get; the API accepts 1–30 s. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `auto` lets dx probe the server when it is added. `secret` is only shown
 * for servers created before tokens were stored on the server: their token
 * is an environment-variable secret, which is also visible in Thread
 * sandboxes.
 */
export type McpAuthMode = "auto" | "oauth" | "token" | "none" | "secret";

export interface McpHeaderField {
  /** Stable row identity for the editor. */
  readonly key: string;
  readonly name: string;
  /** For a stored secret, empty keeps the stored value. */
  readonly value: string;
  readonly secret: boolean;
  /** A secret saved earlier; it cannot be made visible again. */
  readonly stored: boolean;
}

export interface McpServerFields {
  readonly endpoint: string;
  readonly name: string;
  /** Empty: derived from the name. */
  readonly moduleId: string;
  /** Whether the person typed the ID, so the name no longer drives it. */
  readonly moduleIdEdited: boolean;
  readonly auth: McpAuthMode;
  /** A new token; empty keeps a stored one. */
  readonly token: string;
  readonly oauthClientId: string;
  /** A new client secret; empty keeps a stored one. */
  readonly oauthClientSecret: string;
  readonly clientName: string;
  readonly headers: ReadonlyArray<McpHeaderField>;
}

export const emptyMcpFields: McpServerFields = {
  endpoint: "",
  name: "",
  moduleId: "",
  moduleIdEdited: false,
  auth: "auto",
  token: "",
  oauthClientId: "",
  oauthClientSecret: "",
  clientName: "",
  headers: [],
};

/** The module ID dx derives from a name, as Core does. */
export const mcpModuleIdFor = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "");

/** Typing a name keeps the ID in step until the person edits the ID. */
export const withMcpName = (
  fields: McpServerFields,
  name: string,
): McpServerFields => ({
  ...fields,
  name,
  moduleId: fields.moduleIdEdited ? fields.moduleId : mcpModuleIdFor(name),
});

/** URLs are typed without a scheme as often as with one. */
export const normalizeMcpEndpoint = (value: string) => {
  const trimmed = value.trim();
  return trimmed === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
};

const comparable = (value: string) => {
  try {
    const url = new URL(normalizeMcpEndpoint(value));
    return `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
};

/** The template a URL belongs to, by its main or alternate URLs. */
export const mcpTemplateForEndpoint = (
  endpoint: string,
): McpTemplate | undefined => {
  const key = comparable(endpoint);
  return MCP_TEMPLATES.find((template) =>
    [template.url, ...(template.alternateUrls ?? [])].some(
      (url) => comparable(url) === key,
    ),
  );
};

export const mcpFieldsForTemplate = (
  template: McpTemplate,
): McpServerFields => ({
  ...emptyMcpFields,
  endpoint: template.url,
  name: template.name,
  moduleId: mcpModuleIdFor(template.name),
  auth: template.auth === "bearer" ? "token" : template.auth,
  clientName: template.clientName ?? "",
});

export const mcpFieldsFor = (server: McpServerData): McpServerFields => ({
  endpoint: server.endpoint,
  name: server.name,
  moduleId: server.moduleId,
  moduleIdEdited: true,
  auth:
    server.authType === "oauth"
      ? "oauth"
      : server.hasStoredToken
        ? "token"
        : server.authReference !== undefined
          ? "secret"
          : server.authType === "bearer"
            ? "token"
            : "none",
  token: "",
  oauthClientId: server.oauthClientId ?? "",
  oauthClientSecret: "",
  clientName: server.clientName ?? "",
  headers: server.headers.map((header) => ({
    key: `stored-${header.name.toLowerCase()}`,
    name: header.name,
    value: header.value ?? "",
    secret: header.secret,
    stored: header.secret,
  })),
});

/** The URL OAuth providers send people back to after signing in. */
export const mcpOAuthCallbackUrl = () =>
  `${window.location.origin}/v1/settings/personal/mcp-servers/oauth/callback`;

/** Header names and values that usually carry credentials. */
export const looksSecret = (name: string, value: string) =>
  /(auth|token|secret|key|password|credential|session|cookie)/i.test(name) ||
  /^(bearer|basic|token)\s+\S/i.test(value) ||
  /^(sk|pk|rk|ghp|gho|github_pat|xox[abp]|phx|nrak|bkua)[-_]/i.test(value);

/** `Name: value` lines, as copied from docs or curl commands. */
export const parsePastedHeaders = (
  text: string,
): ReadonlyArray<McpHeaderField> =>
  text.split(/\r?\n/).flatMap((raw) => {
    const line = raw
      .replace(/^\s*(-H|--header)\s+/, "")
      .replace(/^['"]|['"]$/g, "");
    const index = line.indexOf(":");
    if (index <= 0) return [];
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    return name === ""
      ? []
      : [
          {
            key: crypto.randomUUID(),
            name,
            value,
            secret: looksSecret(name, value),
            stored: false,
          },
        ];
  });

/** An empty header row for the editor. */
export const emptyMcpHeader = (): McpHeaderField => ({
  key: crypto.randomUUID(),
  name: "",
  value: "",
  secret: false,
  stored: false,
});

const headerInput = (headers: ReadonlyArray<McpHeaderField>) =>
  headers.flatMap((header) =>
    header.name.trim() === ""
      ? []
      : [
          {
            name: header.name.trim(),
            secret: header.secret,
            ...(header.secret && header.stored && header.value === ""
              ? {}
              : { value: header.value }),
          },
        ],
  );

/** Whether the fields can be saved: a new token-auth server needs a token. */
export const mcpFieldsComplete = (
  fields: McpServerFields,
  server?: McpServerData,
) =>
  fields.endpoint.trim() !== "" &&
  fields.name.trim() !== "" &&
  (fields.auth !== "token" ||
    fields.token.trim().length > 0 ||
    server?.hasStoredToken === true);

/** New servers keep the API defaults: all projects, all roles. */
export const mcpCreateInput = (fields: McpServerFields): McpServerInput => ({
  name: fields.name.trim(),
  endpoint: normalizeMcpEndpoint(fields.endpoint),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  authType:
    fields.auth === "token" || fields.auth === "secret"
      ? "bearer"
      : fields.auth,
  ...(fields.auth === "token" ? { authToken: fields.token.trim() } : {}),
  ...(fields.moduleId.trim() === ""
    ? {}
    : { moduleId: fields.moduleId.trim() }),
  ...(fields.clientName.trim() === ""
    ? {}
    : { clientName: fields.clientName.trim() }),
  ...(fields.auth === "oauth" && fields.oauthClientId.trim() !== ""
    ? {
        oauthClientId: fields.oauthClientId.trim(),
        ...(fields.oauthClientSecret.trim() === ""
          ? {}
          : { oauthClientSecret: fields.oauthClientSecret.trim() }),
      }
    : {}),
  ...(fields.headers.some((header) => header.name.trim() !== "")
    ? { headers: headerInput(fields.headers) }
    : {}),
});

/**
 * Edits leave timeout and grants untouched. A typed token sets or rotates
 * the stored one; choosing no token clears whatever auth the server had.
 * Only fields that changed are sent.
 */
export const mcpUpdateInput = (
  fields: McpServerFields,
  server: McpServerData,
) => {
  const before = mcpFieldsFor(server);
  const authType =
    fields.auth === "oauth"
      ? "oauth"
      : fields.auth === "none"
        ? "none"
        : "bearer";
  const headersChanged =
    JSON.stringify(headerInput(fields.headers)) !==
    JSON.stringify(headerInput(before.headers));
  return {
    name: fields.name.trim(),
    endpoint: normalizeMcpEndpoint(fields.endpoint),
    ...(fields.auth === before.auth || fields.auth === "secret"
      ? {}
      : { authType: authType as "none" | "bearer" | "oauth" }),
    ...(fields.auth === "token" && fields.token.trim().length > 0
      ? { authToken: fields.token.trim() }
      : {}),
    ...(fields.auth === "none" &&
    before.auth !== "none" &&
    (server.hasStoredToken || server.authReference !== undefined)
      ? { authReference: null }
      : {}),
    ...(fields.moduleId.trim() === before.moduleId
      ? {}
      : { moduleId: fields.moduleId.trim() }),
    ...(fields.clientName.trim() === before.clientName
      ? {}
      : { clientName: fields.clientName.trim() }),
    ...(fields.auth !== "oauth" ||
    fields.oauthClientId.trim() === before.oauthClientId
      ? {}
      : { oauthClientId: fields.oauthClientId.trim() }),
    ...(fields.auth === "oauth" && fields.oauthClientSecret.trim() !== ""
      ? { oauthClientSecret: fields.oauthClientSecret.trim() }
      : {}),
    ...(headersChanged ? { headers: headerInput(fields.headers) } : {}),
  };
};

/** How the server authenticates, in the words the settings use. */
export const mcpAuthLabel = (server: McpServerData) =>
  server.authType === "oauth"
    ? "OAuth"
    : server.authType === "bearer"
      ? "Bearer Token"
      : "No Authentication";

const ERROR_CODES: Readonly<Record<string, string>> = {
  AUTHENTICATION_REQUIRED: "The server refused the credentials.",
  REQUEST_TIMEOUT: "The server did not answer in time.",
  REDIRECT_BLOCKED: "The server redirected; use its final URL.",
  DNS_LOOKUP_FAILED: "The server's hostname did not resolve.",
  TOOL_LIMIT_EXCEEDED: "The server lists more than 64 tools.",
};

/** One line about the connection: connected, signed out, or what failed. */
export const mcpServerStatus = (
  server: McpServerData,
): { readonly tone: "ok" | "warn" | "muted"; readonly text: string } => {
  if (!server.enabled) return { tone: "muted", text: "Turned off" };
  if (server.authType === "oauth" && !server.signedIn)
    return { tone: "warn", text: "Sign in required" };
  if (server.healthStatus === "unhealthy")
    return {
      tone: "warn",
      text: ERROR_CODES[server.healthErrorCode ?? ""] ?? "Could not connect",
    };
  if (server.tools.length === 0)
    return { tone: "muted", text: "Tools not discovered" };
  const pending = server.tools.filter(
    (tool) => tool.policy === "review",
  ).length;
  if (pending > 0)
    return {
      tone: "warn",
      text: `${pending} ${pending === 1 ? "tool" : "tools"} to review`,
    };
  const allowed = server.tools.filter((tool) => tool.policy === "allow").length;
  return {
    tone: "ok",
    text: `${allowed} of ${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"} on`,
  };
};

/** Server validation errors, placed under the field they name. */
export interface McpFieldErrors {
  readonly name?: string;
  readonly endpoint?: string;
  readonly moduleId?: string;
  readonly auth?: string;
  readonly headers?: string;
  /** Errors about fields the dialog does not show. */
  readonly form?: string;
}

const FIELD_MAP: Readonly<Record<string, keyof McpFieldErrors>> = {
  name: "name",
  endpoint: "endpoint",
  moduleId: "moduleId",
  authType: "auth",
  authToken: "auth",
  oauthClientId: "auth",
  clientName: "form",
  headers: "headers",
};

/** The server's field errors, or undefined when it names no field. */
export const mcpFieldErrors = (error: unknown): McpFieldErrors | undefined => {
  const fieldErrors =
    error instanceof ApiError ? (error.fieldErrors ?? []) : [];
  if (fieldErrors.length === 0) return undefined;
  const errors: Record<string, string> = {};
  for (const { field, message } of fieldErrors) {
    const key = FIELD_MAP[field] ?? "form";
    errors[key] =
      errors[key] === undefined ? message : `${errors[key]} ${message}`;
  }
  return errors as McpFieldErrors;
};

/** Drops the errors of fields the person has since edited; any edit drops the form error. */
export const mcpFieldErrorsAfterEdit = (
  errors: McpFieldErrors,
  before: McpServerFields,
  after: McpServerFields,
): McpFieldErrors => ({
  name: before.name === after.name ? errors.name : undefined,
  endpoint: before.endpoint === after.endpoint ? errors.endpoint : undefined,
  moduleId: before.moduleId === after.moduleId ? errors.moduleId : undefined,
  auth:
    before.auth === after.auth && before.token === after.token
      ? errors.auth
      : undefined,
  headers: before.headers === after.headers ? errors.headers : undefined,
  form: undefined,
});

export const mcpFieldErrorsShown = (errors: McpFieldErrors) =>
  Object.values(errors).some((value) => value !== undefined);
