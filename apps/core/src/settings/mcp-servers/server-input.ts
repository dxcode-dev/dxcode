import type { SettingsFieldError } from "@dx/api";
import {
  MAX_MCP_HEADERS,
  McpClientName,
  McpHeaderName,
  McpModuleId,
  type McpServerAuthType,
  RESERVED_MCP_HEADER_NAMES,
  type StoredMcpHeader,
} from "@dx/domain";
import { Option, Schema } from "effect";
import { type McpServerSecretName, mcpHeaderSecretName } from "./secrets.js";

type Checked<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: SettingsFieldError };

const fail = (field: string, message: string) =>
  ({ ok: false, error: { field, message } }) as const;

/** Header values may not contain control characters other than tab. */
const validHeaderValue = (value: string) =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code === 9 || (code >= 32 && code !== 127);
  });

export interface HeaderPlan {
  readonly headers: ReadonlyArray<StoredMcpHeader>;
  /** Secret values to store, keyed by secret name. */
  readonly writes: ReadonlyArray<{
    readonly name: McpServerSecretName;
    readonly value: string;
  }>;
  /** Every header secret that stays; others are deleted. */
  readonly keep: ReadonlyArray<McpServerSecretName>;
}

/**
 * Checks a full header list. A secret header without a value keeps the
 * value stored under its name; a header that was not secret before needs one.
 * Authorization is reserved for the bearer token or OAuth unless the server
 * uses no auth.
 */
export const planMcpHeaders = (
  inputs: ReadonlyArray<{
    readonly name: string;
    readonly value?: string;
    readonly secret?: boolean;
  }>,
  authType: McpServerAuthType,
  storedSecrets: ReadonlySet<string>,
): Checked<HeaderPlan> => {
  if (inputs.length > MAX_MCP_HEADERS)
    return fail("headers", `Add up to ${MAX_MCP_HEADERS} headers.`);
  const seen = new Set<string>();
  const headers: Array<StoredMcpHeader> = [];
  const writes: Array<{ name: McpServerSecretName; value: string }> = [];
  const keep: Array<McpServerSecretName> = [];
  for (const input of inputs) {
    const name = input.name.trim();
    const lower = name.toLowerCase();
    if (Option.isNone(Schema.decodeOption(McpHeaderName)(name)))
      return fail(
        "headers",
        `“${name || "(blank)"}” is not a valid header name.`,
      );
    if (RESERVED_MCP_HEADER_NAMES.has(lower))
      return fail("headers", `dx sets the ${name} header itself.`);
    if (lower === "authorization" && authType !== "none")
      return fail(
        "headers",
        "Authorization comes from the bearer token or OAuth sign-in. Remove the header or choose No authentication.",
      );
    if (seen.has(lower)) return fail("headers", `${name} is listed twice.`);
    seen.add(lower);
    const value = input.value;
    if (value !== undefined && !validHeaderValue(value))
      return fail("headers", `${name} has a value with line breaks.`);
    const secretName = mcpHeaderSecretName(name);
    if (input.secret === true) {
      if (value !== undefined && value !== "") {
        writes.push({ name: secretName, value });
      } else if (!storedSecrets.has(secretName)) {
        return fail("headers", `Enter a value for ${name}.`);
      }
      keep.push(secretName);
      headers.push({ name, secret: true });
    } else {
      headers.push({ name, secret: false, value: value ?? "" });
    }
  }
  return { ok: true, value: { headers, writes, keep } };
};

export const checkMcpModuleId = (value: string): Checked<McpModuleId> => {
  const decoded = Schema.decodeOption(McpModuleId)(value.trim());
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value }
    : fail(
        "moduleId",
        "Use lowercase letters, digits, - and _, starting with a letter or digit.",
      );
};

/** An empty string means the default client name. */
export const checkMcpClientName = (
  value: string,
): Checked<McpClientName | undefined> => {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  const decoded = Schema.decodeOption(McpClientName)(trimmed);
  return Option.isSome(decoded)
    ? { ok: true, value: decoded.value }
    : fail("clientName", "Enter a client name up to 80 characters.");
};
