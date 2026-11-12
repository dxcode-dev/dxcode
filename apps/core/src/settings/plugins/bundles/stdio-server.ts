import {
  MAX_PLUGIN_STDIO_ARGS,
  MAX_PLUGIN_STDIO_ENV,
  MAX_PLUGIN_STDIO_VALUE_LENGTH,
  McpServerName,
  type PluginBundleStdioMcpServer,
} from "@dx/domain";
import { Option, Schema } from "effect";
import {
  type BundleFolder,
  isRecord,
  manifestPath,
  truncate,
} from "./bundle-reader.js";
import { packageable } from "./plugin-package.js";

/**
 * Checks one local (stdio) MCP server entry against Agent Plugins §7.2.1 and
 * returns what dx stores, or a reason to skip it. Both plugin formats use it;
 * Claude Code's names for the two directories are rewritten first, so dx
 * stores only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`.
 */

const PLACEHOLDERS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const placeholder = /\$\{([^}]*)\}/g;

export type StdioCheck =
  | { readonly ok: true; readonly server: PluginBundleStdioMcpServer }
  | { readonly ok: false; readonly reason: string };

export interface StdioOptions {
  /**
   * Claude Code: `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` mean the
   * two directories; any other variable is read from the environment, which
   * dx cannot promise, so such a server is skipped. Agent Plugins expands
   * only the two and leaves other text as it is.
   */
  readonly claude: boolean;
}

const fail = (reason: string): StdioCheck => ({ ok: false, reason });

/** Rewrites Claude Code's directory variables and refuses other ones. */
const normalize = (
  value: string,
  options: StdioOptions,
): string | { readonly variable: string } => {
  if (!options.claude) return value;
  let unknown: string | undefined;
  const rewritten = value.replace(placeholder, (match, name: string) => {
    if (name === "CLAUDE_PLUGIN_ROOT") return `\${PLUGIN_ROOT}`;
    if (name === "CLAUDE_PLUGIN_DATA") return `\${PLUGIN_DATA}`;
    if (PLACEHOLDERS.has(name)) return match;
    unknown ??= name;
    return match;
  });
  return unknown === undefined ? rewritten : { variable: unknown };
};

/** A `./` path that must name a file in the plugin that reaches the Orb. */
const pluginFile = (folder: BundleFolder, raw: string) => {
  const path = manifestPath(raw);
  if (path === "outside" || path === "") return undefined;
  const entry = folder.files.get(path);
  return entry !== undefined && packageable(entry) ? path : undefined;
};

/**
 * Control and direction-changing characters, which would let a reviewed
 * command line read differently from what runs.
 */
const deceptive = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** §7.2.1 `cwd`: plugin-relative, or rooted at one of the two directories. */
const validCwd = (value: string) => {
  const rooted = /^\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}(\/.*)?$/.exec(value);
  const rest = rooted !== null ? (rooted[2] ?? "") : undefined;
  if (rest === undefined && !value.startsWith("./")) return false;
  const tail = rest ?? value;
  if (tail.includes("${") || tail.includes("\\") || tail.includes("\0"))
    return false;
  return !tail.split("/").some((segment) => segment === "..");
};

export const checkStdioServer = (
  folder: BundleFolder,
  serverName: string,
  entry: Record<string, unknown>,
  options: StdioOptions,
): StdioCheck => {
  const decodedName = Schema.decodeOption(McpServerName)(serverName.trim());
  if (Option.isNone(decodedName)) {
    return fail("The server name is empty or longer than 80 characters.");
  }
  if (typeof entry.command !== "string" || entry.command.trim() === "") {
    return fail("The server has no command.");
  }
  const values = [
    entry.command,
    ...(Array.isArray(entry.args) ? entry.args : []),
    ...(isRecord(entry.env) ? Object.values(entry.env) : []),
    entry.cwd,
  ];
  if (
    values.some((value) => typeof value === "string" && deceptive.test(value))
  ) {
    return fail(
      "The server's command, args, env, or cwd holds a control or direction character.",
    );
  }
  // §7.2.1: one executable token, a bare name or a `./` path, never expanded.
  // Claude Code plugins name their own files through ${CLAUDE_PLUGIN_ROOT}.
  let command = entry.command.trim();
  const claudeRoot = `\${CLAUDE_PLUGIN_ROOT}/`;
  if (options.claude && command.startsWith(claudeRoot)) {
    command = `./${command.slice(claudeRoot.length)}`;
  }
  if (/\s/.test(command)) {
    return fail(
      "The command must be one executable, with its arguments in args.",
    );
  }
  if (command.includes("${")) {
    return fail("The command must not hold a variable.");
  }
  if (command.length > 256) return fail("The command is too long.");
  if (command.startsWith("./")) {
    const path = pluginFile(folder, command);
    if (path === undefined) {
      return fail(`The command ${truncate(command, 80)} is not in the plugin.`);
    }
    command = `./${path}`;
  } else if (command.includes("/") || command.includes("\\")) {
    return fail(
      "The command must be a bare executable name or a ./ path in the plugin.",
    );
  }

  const rawArgs = entry.args ?? [];
  if (!Array.isArray(rawArgs)) return fail("args must be a list of text.");
  if (rawArgs.length > MAX_PLUGIN_STDIO_ARGS) {
    return fail(`The server has more than ${MAX_PLUGIN_STDIO_ARGS} args.`);
  }
  const args: Array<string> = [];
  for (const arg of rawArgs) {
    if (typeof arg !== "string") return fail("args must be a list of text.");
    if (arg.length > MAX_PLUGIN_STDIO_VALUE_LENGTH || arg.includes("\0")) {
      return fail("An argument is too long or holds a NUL character.");
    }
    const normalized = normalize(arg, options);
    if (typeof normalized !== "string") {
      return fail(
        `The server reads \${${truncate(normalized.variable, 64)}}, which dx cannot supply.`,
      );
    }
    args.push(normalized);
  }

  const rawEnv = entry.env ?? {};
  if (!isRecord(rawEnv)) return fail("env must be an object of text values.");
  const env: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(rawEnv)) {
    if (typeof value !== "string") {
      return fail(`env ${truncate(name, 64)} is not text.`);
    }
    if (!envName.test(name)) {
      return fail(`env ${truncate(name, 64)} is not a valid variable name.`);
    }
    if (PLACEHOLDERS.has(name)) {
      return fail(`env must not set ${name}; dx sets it.`);
    }
    // Claude Code: `"KEY": "${KEY}"` passes the variable through, and the
    // Orb's environment already does that.
    if (options.claude && value === `\${${name}}`) continue;
    if (value.length > MAX_PLUGIN_STDIO_VALUE_LENGTH || value.includes("\0")) {
      return fail(`env ${truncate(name, 64)} is too long or holds a NUL.`);
    }
    const normalized = normalize(value, options);
    if (typeof normalized !== "string") {
      return fail(
        `env ${truncate(name, 64)} reads \${${truncate(normalized.variable, 64)}}, which dx cannot supply.`,
      );
    }
    env.push({ name, value: normalized });
  }
  if (env.length > MAX_PLUGIN_STDIO_ENV) {
    return fail(
      `The server sets more than ${MAX_PLUGIN_STDIO_ENV} env values.`,
    );
  }

  let cwd: string | undefined;
  if (entry.cwd !== undefined) {
    if (typeof entry.cwd !== "string") return fail("cwd must be text.");
    const normalized = normalize(entry.cwd.trim(), options);
    if (typeof normalized !== "string" || !validCwd(normalized)) {
      return fail(
        `cwd must be a ./ path in the plugin, or start with \${PLUGIN_ROOT} or \${PLUGIN_DATA}, and stay inside it.`,
      );
    }
    if (normalized.length > 512) return fail("cwd is too long.");
    cwd = normalized;
  }

  return {
    ok: true,
    server: {
      transport: "stdio",
      name: decodedName.value,
      command,
      args,
      env,
      ...(cwd === undefined ? {} : { cwd }),
    },
  };
};
