import {
  isStdioMcpServer,
  MAX_PLUGIN_BUNDLE_MCP_SERVERS,
  MAX_PLUGIN_FILE_BYTES,
  McpServerEndpoint,
  McpServerName,
  type PluginBundleMcpServer,
  PluginName,
  RESERVED_MCP_HEADER_NAMES,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import {
  type BundleFolder,
  finishBundle,
  isRecord,
  readSkillFolders,
  reject,
  truncate,
} from "./bundle-reader.js";
import { DX_EXTENSION_NAMESPACE, readDxExtension } from "./dx-extension.js";
import { buildPluginPackage } from "./plugin-package.js";
import { checkStdioServer } from "./stdio-server.js";

/**
 * Reads a plugin in the Agent Plugins format (https://agent-plugins.org,
 * versions 1.0.0 and 1.1.0): the root `plugin.json`, skills in
 * `skills/<name>/SKILL.md`, and MCP servers in the root `mcp.json`. The rules
 * follow the specification's loader requirements: a closed manifest whose
 * unknown fields are reported and ignored, fixed component locations, and
 * failures kept to the narrowest part. dx's own additions live under the
 * `dev.dxcode` namespace, read by `dx-extension.ts`.
 */

export const AGENT_PLUGINS_MANIFEST = "plugin.json";
export { DX_EXTENSION_NAMESPACE };

type SpecVersion = "1.0.0" | "1.1.0";

const SPEC_VERSIONS: ReadonlyArray<SpecVersion> = ["1.0.0", "1.1.0"];

const pluginSchema = (version: SpecVersion) =>
  `https://agent-plugins.org/schemas/${version}/plugin.schema.json`;

const mcpSchema = (version: SpecVersion) =>
  `https://agent-plugins.org/schemas/${version}/mcp.schema.json`;

const manifestFields: Record<SpecVersion, ReadonlySet<string>> = {
  "1.0.0": new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]),
  "1.1.0": new Set([
    "$schema",
    "name",
    "displayName",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]),
};

/** The spec's name rule; dx's PluginName follows the same rule. */
const specName = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const stringFields = [
  "displayName",
  "version",
  "description",
  "homepage",
  "repository",
  "license",
] as const;

const notOurs = "Not an Agent Plugins manifest field; ignored.";

const httpToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * An RFC 9110 field value: visible Latin-1 characters, with spaces and tabs
 * only between them. Spec §7.2.1 requires valid HTTP header fields.
 */
const isInvalidHeaderValue = (value: string) =>
  /^[ \t]|[ \t]$/.test(value) ||
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09) || code === 0x7f || code > 0xff;
  });

const isLoopback = (hostname: string) =>
  hostname === "localhost" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
  hostname === "[::1]";

const isObjectOfObjects = (value: unknown) =>
  isRecord(value) && Object.values(value).every(isRecord);

export const readAgentPluginsFolder = Effect.fn("readAgentPluginsFolder")(
  function* (folder: BundleFolder) {
    const { files, paths, skip } = folder;

    // §5: the manifest. Anything but an unknown field is fatal.
    const text = yield* folder.read(
      AGENT_PLUGINS_MANIFEST,
      MAX_PLUGIN_FILE_BYTES,
    );
    if (!text.ok) {
      return yield* reject(`plugin.json: ${text.reason}`);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(text.text);
    } catch {
      return yield* reject("plugin.json is not valid JSON.");
    }
    if (!isRecord(manifest)) {
      return yield* reject("plugin.json is not a JSON object.");
    }
    const declaredSchema = manifest.$schema;
    if (typeof declaredSchema !== "string") {
      return yield* reject(
        "plugin.json has no $schema naming the Agent Plugins version.",
      );
    }
    const version = SPEC_VERSIONS.find(
      (candidate) => pluginSchema(candidate) === declaredSchema,
    );
    if (version === undefined) {
      return yield* reject(
        `plugin.json targets an Agent Plugins version dx does not support: ${truncate(declaredSchema, 120)}. dx reads versions ${SPEC_VERSIONS.join(" and ")}.`,
      );
    }
    const permitted = manifestFields[version];

    const name = manifest.name;
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > 64 ||
      !specName.test(name)
    ) {
      return yield* reject(
        typeof name === "string"
          ? `plugin.json: the name ${JSON.stringify(truncate(name, 64))} must be 1 to 64 lowercase letters, digits, hyphens, and periods, start and end with a letter or digit, and not repeat a hyphen or period.`
          : "plugin.json: the name is missing or is not text.",
      );
    }
    const pluginName = Schema.decodeOption(PluginName)(name);
    if (Option.isNone(pluginName)) {
      return yield* reject(`plugin.json: dx cannot use the name ${name}.`);
    }
    for (const field of stringFields) {
      if (
        permitted.has(field) &&
        manifest[field] !== undefined &&
        typeof manifest[field] !== "string"
      ) {
        return yield* reject(`plugin.json: ${field} must be text.`);
      }
    }
    const author = manifest.author;
    if (
      author !== undefined &&
      (!isRecord(author) ||
        Object.entries(author).some(
          ([key, value]) =>
            !["name", "email", "url"].includes(key) ||
            typeof value !== "string",
        ))
    ) {
      return yield* reject(
        "plugin.json: author may hold only name, email, and url, each as text.",
      );
    }
    const keywords = manifest.keywords;
    if (
      keywords !== undefined &&
      (!Array.isArray(keywords) ||
        keywords.some((keyword) => typeof keyword !== "string"))
    ) {
      return yield* reject("plugin.json: keywords must be a list of text.");
    }
    // §8.1: extensions is an object of objects. 1.0.0 ignores a non-object
    // extensions; 1.1.0 rejects it.
    let extensions: Record<string, unknown> = {};
    if (manifest.extensions !== undefined) {
      if (isObjectOfObjects(manifest.extensions)) {
        extensions = manifest.extensions as Record<string, unknown>;
      } else if (version === "1.0.0" && !isRecord(manifest.extensions)) {
        skip("plugin.json#extensions", "extensions is not an object; ignored.");
      } else {
        return yield* reject(
          "plugin.json: extensions must map each namespace to an object.",
        );
      }
    }
    for (const field of Object.keys(manifest)) {
      if (!permitted.has(field)) skip(`plugin.json#${field}`, notOurs);
    }

    // §8: dx's namespace. Other clients' namespaces are never read.
    const code = yield* readDxExtension(
      folder,
      extensions[DX_EXTENSION_NAMESPACE],
    );

    const displayName =
      permitted.has("displayName") &&
      typeof manifest.displayName === "string" &&
      manifest.displayName.trim() !== ""
        ? truncate(manifest.displayName.trim(), 96)
        : pluginName.value;
    const description =
      typeof manifest.description === "string"
        ? truncate(manifest.description.trim(), 1_024)
        : "";
    const declaredVersion =
      typeof manifest.version === "string" && manifest.version.trim() !== ""
        ? truncate(manifest.version.trim(), 64)
        : undefined;

    // §6 and §7.1: each direct child of skills/ holding SKILL.md is a skill.
    // A file named skills turns skills off; nothing deeper is searched.
    const skillFolders: Array<string> = [];
    if (files.has("skills")) {
      skip("skills", "skills is a file, not a folder; skills are off.");
    } else {
      for (const path of folder.under("skills")) {
        const parts = path.split("/");
        if (parts.length === 3 && parts[2] === "SKILL.md") {
          skillFolders.push(`skills/${parts[1] ?? ""}`);
        }
      }
    }
    skillFolders.sort();
    const skills = yield* readSkillFolders(folder, skillFolders, {
      pluginName: pluginName.value,
      componentFolders: new Set(),
      requireFolderName: true,
    });

    // §7.2: MCP servers from the root mcp.json only.
    const mcpServers: Array<PluginBundleMcpServer> = [];
    const mcpIsFolder = paths.some((path) => path.startsWith("mcp.json/"));
    if (mcpIsFolder) {
      skip("mcp.json", "mcp.json is a folder, not a file; MCP is off.");
    } else if (files.has("mcp.json")) {
      const config = yield* readMcpConfig(folder, version);
      if (config !== undefined) {
        for (const [serverName, server] of Object.entries(config)) {
          const imported = remoteServer(folder, version, serverName, server);
          if (imported === undefined) continue;
          const label = `mcp.json#${serverName}`;
          if (mcpServers.some(({ name }) => name === imported.name)) {
            skip(
              label,
              `Another MCP server is already named ${imported.name}.`,
            );
          } else if (mcpServers.length >= MAX_PLUGIN_BUNDLE_MCP_SERVERS) {
            skip(label, "The bundle has too many MCP servers.");
          } else {
            mcpServers.push(imported);
          }
        }
      }
    }

    const runsLocally = mcpServers.some(isStdioMcpServer);
    return yield* finishBundle(folder, {
      ...(runsLocally ? { package: yield* buildPluginPackage(folder) } : {}),
      format: "agent-plugins",
      name: pluginName.value,
      displayName,
      description,
      declaredVersion,
      skills,
      mcpServers,
      code,
    });
  },
);

/** §7.2.2 rule 2: a bad mcp.json turns MCP off and is reported. */
const readMcpConfig = Effect.fn("readMcpConfig")(function* (
  folder: BundleFolder,
  version: SpecVersion,
) {
  const off = (reason: string) => {
    folder.skip("mcp.json", `${reason} MCP is off for this plugin.`);
    return undefined;
  };
  const text = yield* folder.read("mcp.json", MAX_PLUGIN_FILE_BYTES);
  if (!text.ok) return off(text.reason);
  let config: unknown;
  try {
    config = JSON.parse(text.text);
  } catch {
    return off("mcp.json is not valid JSON.");
  }
  if (!isRecord(config)) return off("mcp.json is not a JSON object.");
  if (typeof config.$schema !== "string") {
    return off("mcp.json has no $schema.");
  }
  if (config.$schema !== mcpSchema(version)) {
    return off(
      `mcp.json's $schema does not match plugin.json's Agent Plugins version, ${version}.`,
    );
  }
  const extra = Object.keys(config).filter(
    (key) => key !== "$schema" && key !== "mcpServers",
  );
  if (extra.length > 0) {
    return off(
      `mcp.json has fields beyond $schema and mcpServers: ${extra.join(", ")}.`,
    );
  }
  if (!isRecord(config.mcpServers)) {
    return off("mcpServers must be an object.");
  }
  return config.mcpServers;
});

const variantFields: Record<string, ReadonlySet<string>> = {
  stdio: new Set(["type", "command", "args", "env", "cwd", "extensions"]),
  "streamable-http": new Set(["type", "url", "headers", "extensions"]),
  sse: new Set(["type", "url", "headers", "extensions"]),
};

/**
 * §7.2.1: one server entry, checked against its closed variant. Returns the
 * server dx imports, or skips it with a reason.
 */
const remoteServer = (
  folder: BundleFolder,
  version: SpecVersion,
  serverName: string,
  server: unknown,
): PluginBundleMcpServer | undefined => {
  const label = `mcp.json#${serverName}`;
  const skip = (reason: string) => {
    folder.skip(label, reason);
    return undefined;
  };
  if (!isRecord(server)) return skip("The server entry is not an object.");
  const type = server.type;
  if (typeof type !== "string") return skip("The server entry has no type.");
  const allowed = variantFields[type];
  if (allowed === undefined) {
    return skip(
      `The server type ${truncate(type, 40)} is not an Agent Plugins transport.`,
    );
  }
  const unknown = Object.keys(server).filter(
    (key) => !allowed.has(key) || (key === "extensions" && version === "1.0.0"),
  );
  if (unknown.length > 0) {
    return skip(
      `The server entry has fields its type does not allow: ${unknown.join(", ")}.`,
    );
  }
  if (
    server.extensions !== undefined &&
    !isObjectOfObjects(server.extensions)
  ) {
    return skip(
      "The server's extensions must map each namespace to an object.",
    );
  }
  if (type === "stdio") {
    const checked = checkStdioServer(folder, serverName, server, {
      claude: false,
    });
    return checked.ok ? checked.server : skip(checked.reason);
  }
  if (type === "sse") {
    return skip(
      "Legacy SSE MCP servers are not supported; use streamable-http.",
    );
  }
  if (typeof server.url !== "string" || server.url === "") {
    return skip("The server has no URL.");
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    return skip("The server URL is not an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return skip("The server URL must use https.");
  }
  if (url.username !== "" || url.password !== "" || server.url.includes("#")) {
    return skip("The server URL must not hold user info or a fragment.");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return skip("The server URL must use https.");
  }
  if (url.protocol === "http:") {
    return skip(
      "dx cannot reach a server on this computer's loopback address.",
    );
  }
  const endpoint = Schema.decodeOption(McpServerEndpoint)(server.url);
  if (Option.isNone(endpoint)) {
    return skip("dx connects only to https:// MCP servers on port 443.");
  }
  const decodedName = Schema.decodeOption(McpServerName)(serverName.trim());
  if (Option.isNone(decodedName)) {
    return skip("The server name is empty or longer than 80 characters.");
  }
  const declared = server.headers ?? {};
  if (!isRecord(declared)) return skip("headers must be an object.");
  const seen = new Set<string>();
  for (const [header, value] of Object.entries(declared)) {
    if (typeof value !== "string")
      return skip(`Header ${truncate(header, 64)} is not text.`);
    if (!httpToken.test(header) || header.length > 128) {
      return skip(`Header ${truncate(header, 64)} is not a valid name.`);
    }
    if (isInvalidHeaderValue(value)) {
      return skip(`Header ${truncate(header, 64)} has an invalid value.`);
    }
    const lower = header.toLowerCase();
    if (seen.has(lower)) {
      return skip(`Header ${truncate(header, 64)} appears more than once.`);
    }
    seen.add(lower);
  }
  // Headers are literal (§7.2.1). dx sends its own protocol headers and
  // keeps credentials in MCP server settings, never in package data.
  const headers: Array<{ readonly name: string; readonly value: string }> = [];
  for (const [header, value] of Object.entries(declared) as Array<
    [string, string]
  >) {
    const lower = header.toLowerCase();
    if (RESERVED_MCP_HEADER_NAMES.has(lower)) {
      folder.skip(label, `Header ${truncate(header, 64)} is set by dx.`);
    } else if (lower === "authorization") {
      folder.skip(
        label,
        "Set the Authorization header in MCP server settings.",
      );
    } else if (headers.length < 16 && value.length <= 4_096) {
      headers.push({ name: header, value });
    } else {
      folder.skip(label, `Header ${header} was not imported.`);
    }
  }
  return {
    name: decodedName.value,
    endpoint: endpoint.value,
    authType: "none",
    headers,
  };
};
