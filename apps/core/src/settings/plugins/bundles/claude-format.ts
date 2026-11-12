import {
  isStdioMcpServer,
  MAX_PLUGIN_BUNDLE_MCP_SERVERS,
  MAX_PLUGIN_FILE_BYTES,
  McpServerEndpoint,
  McpServerName,
  type PluginBundleMcpServer,
  type PluginBundleRemoteMcpServer,
  PluginName,
  RESERVED_MCP_HEADER_NAMES,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import {
  type BundleFolder,
  finishBundle,
  isRecord,
  join,
  manifestPath,
  openBundleFolder,
  readSkillFolders,
  reject,
  truncate,
} from "./bundle-reader.js";
import { buildPluginPackage } from "./plugin-package.js";
import { checkStdioServer } from "./stdio-server.js";
import type { ZipArchive } from "./zip.js";

export type { ParsedBundle } from "./bundle-reader.js";

/**
 * Reads a plugin in Claude Code's format from an archive: the
 * `.claude-plugin/plugin.json` manifest, skills, and MCP servers (remote ones, and local ones dxd runs in the Orb). Nothing in the bundle runs; components dx does not support are
 * listed as skipped with a reason.
 */

/** Folders of components dx does not run, with the reason it skips them. */
const unsupportedFolders: ReadonlyArray<readonly [string, string]> = [
  ["agents", "Agents are not supported yet."],
  ["output-styles", "Output styles are not supported."],
  ["workflows", "Workflows are not supported."],
  ["monitors", "Monitors are not supported."],
  ["themes", "Themes are not supported."],
  ["bin", "dx does not run bundled executables."],
];

const unsupportedManifestFields: ReadonlyArray<readonly [string, string]> = [
  ["agents", "Agents are not supported yet."],
  ["hooks", "Hooks are not supported yet."],
  ["lspServers", "LSP servers are not supported."],
  ["outputStyles", "Output styles are not supported."],
  ["workflows", "Workflows are not supported."],
  ["userConfig", "Plugin settings are not supported."],
  ["channels", "Channels are not supported."],
  ["dependencies", "Plugin dependencies are not supported."],
];

const commandsReason =
  "Commands are Claude Code only; dx imports skills and MCP servers.";

const componentFolders = new Set([
  "skills",
  "commands",
  "hooks",
  ...unsupportedFolders.map(([folder]) => folder),
]);

const pathList = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];

const slug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

/** True when the folder holds a plugin in Claude Code's format. */
export const isClaudeBundle = (folder: BundleFolder) =>
  folder.files.has(".claude-plugin/plugin.json") ||
  folder.files.has(".mcp.json") ||
  folder.files.has("SKILL.md") ||
  folder.under("skills").length > 0 ||
  folder.under("commands").length > 0;

/** Rejects a folder with no plugin, pointing at a marketplace's plugins. */
export const rejectMissingPlugin = Effect.fn("rejectMissingPlugin")(function* (
  folder: BundleFolder,
) {
  const marketplace = ".claude-plugin/marketplace.json";
  if (folder.files.has(marketplace)) {
    const text = yield* folder.peek(marketplace, MAX_PLUGIN_FILE_BYTES);
    let folders: ReadonlyArray<string> = [];
    if (text.ok) {
      try {
        const parsed: unknown = JSON.parse(text.text);
        if (isRecord(parsed) && Array.isArray(parsed.plugins)) {
          folders = parsed.plugins.flatMap((plugin) =>
            isRecord(plugin) && typeof plugin.source === "string"
              ? [manifestPath(plugin.source)]
              : [],
          );
        }
      } catch {
        folders = [];
      }
    }
    const listed = folders
      .filter((path) => path !== "outside" && path !== "")
      .slice(0, 5)
      .map((path) => join(folder.root, path));
    return yield* reject(
      listed.length === 0
        ? "This is a plugin marketplace, not a plugin. Import one of its plugins by its folder URL."
        : `This is a plugin marketplace, not a plugin. Import one of its plugins by its folder URL, such as ${listed.join(", ")}.`,
    );
  }
  return yield* reject(
    folder.root === ""
      ? "No Claude Code plugin was found at the top of the archive."
      : `No Claude Code plugin was found in ${folder.root}.`,
  );
});

export const readClaudeFolder = Effect.fn("readClaudeFolder")(function* (
  folder: BundleFolder,
  options: {
    /** Names the plugin when it has no plugin.json. */
    readonly fallbackName: string;
  },
) {
  const { files, under, read, skip } = folder;
  if (!isClaudeBundle(folder)) return yield* rejectMissingPlugin(folder);

  // The manifest.
  let manifest: Record<string, unknown> = {};
  if (files.has(".claude-plugin/plugin.json")) {
    const text = yield* read(
      ".claude-plugin/plugin.json",
      MAX_PLUGIN_FILE_BYTES,
    );
    if (!text.ok) {
      return yield* reject(`.claude-plugin/plugin.json: ${text.reason}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      return yield* reject(".claude-plugin/plugin.json is not valid JSON.");
    }
    if (!isRecord(parsed)) {
      return yield* reject(".claude-plugin/plugin.json is not a JSON object.");
    }
    manifest = parsed;
  }
  const declaredName =
    typeof manifest.name === "string" ? manifest.name.trim() : undefined;
  const name = Schema.decodeOption(PluginName)(
    declaredName ?? slug(options.fallbackName),
  );
  if (Option.isNone(name)) {
    return yield* reject(
      declaredName === undefined
        ? "Name the plugin in .claude-plugin/plugin.json."
        : `The plugin name must be kebab-case, not ${JSON.stringify(truncate(declaredName, 64))}.`,
    );
  }
  const displayName =
    typeof manifest.displayName === "string" &&
    manifest.displayName.trim() !== ""
      ? truncate(manifest.displayName.trim(), 96)
      : name.value;
  const description =
    typeof manifest.description === "string"
      ? truncate(manifest.description.trim(), 1_024)
      : "";
  const declaredVersion =
    typeof manifest.version === "string" && manifest.version.trim() !== ""
      ? truncate(manifest.version.trim(), 64)
      : undefined;

  for (const [field, reason] of unsupportedManifestFields) {
    if (manifest[field] !== undefined) skip(`plugin.json#${field}`, reason);
  }
  for (const [path, reason] of unsupportedFolders) {
    if (under(path).length > 0) skip(`${path}/`, reason);
  }
  if (files.has("hooks/hooks.json")) {
    skip("hooks/hooks.json", "Hooks are not supported yet.");
  }
  if (files.has(".lsp.json"))
    skip(".lsp.json", "LSP servers are not supported.");

  // Skills: every skills folder holds one folder per skill.
  const skillFolders: Array<string> = [];
  const addSkillFolder = (path: string) => {
    if (!skillFolders.includes(path)) skillFolders.push(path);
  };
  const collectSkills = (path: string) => {
    if (files.has(join(path, "SKILL.md"))) {
      addSkillFolder(path);
      return;
    }
    for (const file of under(path)) {
      const rest = file.slice(path === "" ? 0 : path.length + 1);
      const parts = rest.split("/");
      if (parts.length === 2 && parts[1] === "SKILL.md") {
        addSkillFolder(join(path, parts[0] ?? ""));
      }
    }
  };
  collectSkills("skills");
  for (const raw of pathList(manifest.skills)) {
    const path = manifestPath(raw);
    if (path === "outside") skip(raw, "The path leaves the plugin folder.");
    else collectSkills(path);
  }
  if (
    under("skills").length === 0 &&
    manifest.skills === undefined &&
    files.has("SKILL.md")
  ) {
    addSkillFolder("");
  }

  const skills = yield* readSkillFolders(folder, skillFolders, {
    pluginName: name.value,
    componentFolders,
    requireFolderName: false,
  });

  // Commands are Claude Code's own slash commands; dx plugins add skills and
  // MCP servers, which work the same in dx and Claude Code Threads.
  if (under("commands").length > 0) skip("commands/", commandsReason);
  if (manifest.commands !== undefined) {
    skip("plugin.json#commands", commandsReason);
  }

  // MCP servers: remote streamable HTTP servers only.
  const mcpConfigs: Array<{ readonly label: string; readonly value: unknown }> =
    [];
  const readJsonConfig = Effect.fn("readClaudeFolder.readJsonConfig")(
    function* (path: string) {
      const text = yield* read(path, MAX_PLUGIN_FILE_BYTES);
      if (!text.ok) {
        skip(path, text.reason);
        return;
      }
      try {
        mcpConfigs.push({ label: path, value: JSON.parse(text.text) });
      } catch {
        skip(path, "The file is not valid JSON.");
      }
    },
  );
  if (files.has(".mcp.json")) yield* readJsonConfig(".mcp.json");
  if (isRecord(manifest.mcpServers)) {
    mcpConfigs.push({ label: "plugin.json", value: manifest.mcpServers });
  } else {
    for (const raw of pathList(manifest.mcpServers)) {
      const path = manifestPath(raw);
      if (path === "outside") skip(raw, "The path leaves the plugin folder.");
      else if (path !== ".mcp.json") yield* readJsonConfig(path);
    }
  }
  const mcpServers: Array<PluginBundleMcpServer> = [];
  for (const config of mcpConfigs) {
    if (!isRecord(config.value)) {
      skip(config.label, "The MCP configuration is not a JSON object.");
      continue;
    }
    const servers = isRecord(config.value.mcpServers)
      ? config.value.mcpServers
      : config.value;
    for (const [serverName, server] of Object.entries(servers)) {
      const label = `${config.label}#${serverName}`;
      if (!isRecord(server)) {
        skip(label, "The server configuration is not a JSON object.");
        continue;
      }
      if (server.command !== undefined || server.type === "stdio") {
        const checked = checkStdioServer(folder, serverName, server, {
          claude: true,
        });
        if (!checked.ok) skip(label, checked.reason);
        else if (
          mcpServers.some(
            ({ name: existing }) => existing === checked.server.name,
          )
        ) {
          skip(
            label,
            `Another MCP server is already named ${checked.server.name}.`,
          );
        } else if (mcpServers.length >= MAX_PLUGIN_BUNDLE_MCP_SERVERS) {
          skip(label, "The bundle has too many MCP servers.");
        } else {
          mcpServers.push(checked.server);
        }
        continue;
      }
      if (
        server.type !== undefined &&
        server.type !== "http" &&
        server.type !== "streamable-http"
      ) {
        skip(label, "dx connects to MCP servers over streamable HTTP only.");
        continue;
      }
      if (typeof server.url !== "string") {
        skip(label, "The server has no URL.");
        continue;
      }
      if (server.url.includes("${")) {
        skip(label, "The server URL reads a variable.");
        continue;
      }
      const endpoint = Schema.decodeOption(McpServerEndpoint)(server.url);
      if (Option.isNone(endpoint)) {
        skip(label, "dx connects only to https:// MCP servers on port 443.");
        continue;
      }
      const decodedName = Schema.decodeOption(McpServerName)(serverName.trim());
      if (Option.isNone(decodedName)) {
        skip(label, "The server name is empty or longer than 80 characters.");
        continue;
      }
      if (
        mcpServers.some(({ name: existing }) => existing === decodedName.value)
      ) {
        skip(
          label,
          `Another MCP server is already named ${decodedName.value}.`,
        );
        continue;
      }
      if (mcpServers.length >= MAX_PLUGIN_BUNDLE_MCP_SERVERS) {
        skip(label, "The bundle has too many MCP servers.");
        continue;
      }
      let authType: PluginBundleRemoteMcpServer["authType"] = "none";
      const headers: Array<{ readonly name: string; readonly value: string }> =
        [];
      const declaredHeaders = isRecord(server.headers) ? server.headers : {};
      for (const [header, value] of Object.entries(declaredHeaders)) {
        const lower = header.toLowerCase();
        if (typeof value !== "string") {
          skip(label, `Header ${truncate(header, 64)} is not text.`);
        } else if (RESERVED_MCP_HEADER_NAMES.has(lower)) {
          skip(label, `Header ${truncate(header, 64)} is reserved.`);
        } else if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(header)) {
          skip(label, `Header ${truncate(header, 64)} is not a valid name.`);
        } else if (
          lower === "authorization" &&
          /^Bearer\s+\$\{[^}]+\}$/i.test(value.trim())
        ) {
          authType = "bearer";
        } else if (value.includes("${")) {
          skip(
            label,
            `Header ${header} reads a variable; set it in MCP server settings.`,
          );
        } else if (lower === "authorization") {
          skip(label, "Set the Authorization header in MCP server settings.");
        } else if (headers.length < 16 && value.length <= 4_096) {
          headers.push({ name: header, value });
        } else {
          skip(label, `Header ${header} was not imported.`);
        }
      }
      mcpServers.push({
        name: decodedName.value,
        endpoint: endpoint.value,
        authType,
        headers,
      });
    }
  }

  const runsLocally = mcpServers.some(isStdioMcpServer);
  return yield* finishBundle(folder, {
    ...(runsLocally ? { package: yield* buildPluginPackage(folder) } : {}),
    format: "claude-code",
    name: name.value,
    displayName,
    description,
    declaredVersion,
    skills,
    mcpServers,
  });
});

export const readClaudeBundle = Effect.fn("readClaudeBundle")(function* (
  archive: ZipArchive,
  options: {
    /** The plugin's folder inside the archive, after any wrapping folder. */
    readonly root: string;
    /** Names the plugin when it has no plugin.json. */
    readonly fallbackName: string;
  },
) {
  const folder = yield* openBundleFolder(archive, options.root);
  return yield* readClaudeFolder(folder, options);
});
