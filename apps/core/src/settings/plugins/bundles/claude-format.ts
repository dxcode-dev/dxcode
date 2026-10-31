import {
  MAX_PLUGIN_BUNDLE_MCP_SERVERS,
  MAX_PLUGIN_BUNDLE_SKIPPED,
  MAX_PLUGIN_BUNDLE_TEXT_BYTES,
  MAX_PLUGIN_FILE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_INSTRUCTIONS_BYTES,
  MAX_SKILL_RESOURCE_FILES,
  MAX_SKILL_TOTAL_BYTES,
  MAX_SKILLS_PER_SCOPE,
  McpServerEndpoint,
  McpServerName,
  PluginBundleManifest,
  type PluginBundleMcpServer,
  type PluginBundleSkipped,
  PluginIntegrity,
  PluginName,
  PluginVersion,
  RESERVED_MCP_HEADER_NAMES,
  SkillName,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import YAML from "yaml";
import {
  previewSkillContent,
  type SkillImportRejected,
  type SkillPreview,
} from "../../skills/import.js";
import { PluginBundleRejected } from "./errors.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

/**
 * Reads a plugin in Claude Code's format from an archive: the
 * `.claude-plugin/plugin.json` manifest, skills, and remote MCP servers. Nothing in the bundle runs; components dx does not support are
 * listed as skipped with a reason.
 */

export interface ParsedBundle {
  readonly manifest: PluginBundleManifest;
  readonly skills: ReadonlyArray<SkillPreview>;
  readonly integrity: PluginIntegrity;
  readonly version: PluginVersion;
}

const encoder = new TextEncoder();

const resourceMediaTypes = new Map([
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".toml", "application/toml"],
  [".py", "text/x-python"],
  [".sh", "text/x-shellscript"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".ts", "text/typescript"],
  [".html", "text/html"],
  [".css", "text/css"],
  [".xml", "application/xml"],
  [".sql", "application/sql"],
]);

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

const reject = (reason: string) =>
  Effect.fail(new PluginBundleRejected({ reason }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const truncate = (value: string, maximum: number) =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

const join = (directory: string, name: string) =>
  directory === "" ? name : `${directory}/${name}`;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const extension = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** A path from plugin.json, relative to the plugin root, or "outside". */
const manifestPath = (raw: string): string | "outside" => {
  let path = raw.trim();
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return "outside";
  }
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/, "");
  if (path === "." || path === "") return "";
  return path.split("/").some((segment) => segment === "..") ? "outside" : path;
};

const pathList = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];

/** Splits Markdown into its YAML front matter and body. */
const frontMatter = (
  text: string,
): { readonly data: Record<string, unknown>; readonly body: string } => {
  const source = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (match === null) return { data: {}, body: source };
  let data: unknown;
  try {
    data = YAML.parse(match[1] ?? "", { maxAliasCount: 10 });
  } catch {
    data = undefined;
  }
  return {
    data: isRecord(data) ? data : {},
    body: source.slice(match[0].length),
  };
};

const slug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

const semverCore =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

/** Finds the plugin folder: GitHub archives wrap everything in one folder. */
const topFolder = (entries: ReadonlyArray<ZipEntry>): string => {
  const first = entries[0]?.path.split("/")[0];
  if (first === undefined) return "";
  const prefix = `${first}/`;
  return entries.every(({ path }) => path.startsWith(prefix)) ? prefix : "";
};

export const readClaudeBundle = Effect.fn("readClaudeBundle")(function* (
  archive: ZipArchive,
  options: {
    /** The plugin's folder inside the archive, after any wrapping folder. */
    readonly root: string;
    /** Names the plugin when it has no plugin.json. */
    readonly fallbackName: string;
  },
) {
  const top = topFolder(archive.entries);
  const root = manifestPath(options.root);
  if (root === "outside") {
    return yield* reject("The plugin folder must be inside the repository.");
  }
  const prefix = `${top}${root === "" ? "" : `${root}/`}`;
  const files = new Map<string, ZipEntry>();
  for (const entry of archive.entries) {
    if (entry.path.startsWith(prefix)) {
      files.set(entry.path.slice(prefix.length), entry);
    }
  }
  const paths = [...files.keys()];
  const under = (directory: string) =>
    directory === ""
      ? paths
      : paths.filter((path) => path.startsWith(`${directory}/`));

  let textBytes = 0;
  const read = Effect.fn("readClaudeBundle.read")(function* (
    path: string,
    maxBytes: number,
  ) {
    const entry = files.get(path);
    if (entry === undefined) {
      return { ok: false, reason: "The file is missing." } as const;
    }
    const result = yield* archive.readText(entry, maxBytes);
    if (result.ok) {
      textBytes += encoder.encode(result.text).byteLength;
      if (textBytes > MAX_PLUGIN_BUNDLE_TEXT_BYTES) {
        return yield* reject(
          `The bundle has more than ${MAX_PLUGIN_BUNDLE_TEXT_BYTES.toLocaleString("en-US")} bytes of text.`,
        );
      }
    }
    return result;
  });

  const skipped: Array<PluginBundleSkipped> = [];
  const skip = (path: string, reason: string) => {
    if (skipped.length < MAX_PLUGIN_BUNDLE_SKIPPED) {
      skipped.push({
        path: truncate(path, 256),
        reason: truncate(reason, 256),
      });
    }
  };

  const hasPlugin =
    files.has(".claude-plugin/plugin.json") ||
    files.has(".mcp.json") ||
    files.has("SKILL.md") ||
    under("skills").length > 0 ||
    under("commands").length > 0;
  if (!hasPlugin) {
    const marketplace = files.get(".claude-plugin/marketplace.json");
    if (marketplace !== undefined) {
      const text = yield* archive.readText(marketplace, MAX_PLUGIN_FILE_BYTES);
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
        .filter((folder) => folder !== "outside" && folder !== "")
        .slice(0, 5)
        .map((folder) => join(root, folder));
      return yield* reject(
        listed.length === 0
          ? "This is a plugin marketplace, not a plugin. Import one of its plugins by its folder URL."
          : `This is a plugin marketplace, not a plugin. Import one of its plugins by its folder URL, such as ${listed.join(", ")}.`,
      );
    }
    return yield* reject(
      root === ""
        ? "No Claude Code plugin was found at the top of the archive."
        : `No Claude Code plugin was found in ${root}.`,
    );
  }

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
  for (const [folder, reason] of unsupportedFolders) {
    if (under(folder).length > 0) skip(`${folder}/`, reason);
  }
  if (files.has("hooks/hooks.json")) {
    skip("hooks/hooks.json", "Hooks are not supported yet.");
  }
  if (files.has(".lsp.json"))
    skip(".lsp.json", "LSP servers are not supported.");

  // Skills: every skills folder holds one folder per skill.
  const skillFolders: Array<string> = [];
  const addSkillFolder = (folder: string) => {
    if (!skillFolders.includes(folder)) skillFolders.push(folder);
  };
  const collectSkills = (folder: string) => {
    if (files.has(join(folder, "SKILL.md"))) {
      addSkillFolder(folder);
      return;
    }
    for (const path of under(folder)) {
      const rest = path.slice(folder === "" ? 0 : folder.length + 1);
      const parts = rest.split("/");
      if (parts.length === 2 && parts[1] === "SKILL.md") {
        addSkillFolder(join(folder, parts[0] ?? ""));
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

  const skills: Array<SkillPreview> = [];
  for (const folder of skillFolders) {
    const skillPath = join(folder, "SKILL.md");
    if (skills.length >= MAX_SKILLS_PER_SCOPE) {
      skip(skillPath, "The bundle has too many skills.");
      continue;
    }
    const text = yield* read(skillPath, MAX_SKILL_INSTRUCTIONS_BYTES * 2);
    if (!text.ok) {
      skip(
        skillPath,
        text.reason.startsWith("The file is larger")
          ? `The instructions are longer than ${MAX_SKILL_INSTRUCTIONS_BYTES.toLocaleString("en-US")} bytes.`
          : text.reason,
      );
      continue;
    }
    const { data, body } = frontMatter(text.text);
    const rawName =
      typeof data.name === "string"
        ? data.name.trim().toLowerCase()
        : folder === ""
          ? name.value
          : basename(folder).toLowerCase();
    if (Option.isNone(Schema.decodeOption(SkillName)(rawName))) {
      skip(
        skillPath,
        `The skill name must be kebab-case, not ${JSON.stringify(truncate(rawName, 64))}.`,
      );
      continue;
    }
    if (skills.some(({ manifest }) => manifest.name === rawName)) {
      skip(skillPath, `Another skill is already named ${rawName}.`);
      continue;
    }
    const skillDescription =
      typeof data.description === "string" ? data.description.trim() : "";
    if (skillDescription === "") {
      skip(skillPath, "SKILL.md has no description.");
      continue;
    }
    const instructions = body.trim();
    if (instructions === "") {
      skip(skillPath, "SKILL.md has no instructions.");
      continue;
    }
    if (
      encoder.encode(instructions).byteLength > MAX_SKILL_INSTRUCTIONS_BYTES
    ) {
      skip(
        skillPath,
        `The instructions are longer than ${MAX_SKILL_INSTRUCTIONS_BYTES.toLocaleString("en-US")} bytes.`,
      );
      continue;
    }
    const resources: Array<{
      readonly path: string;
      readonly mediaType: string;
      readonly content: string;
    }> = [];
    let skillBytes = encoder.encode(instructions).byteLength;
    for (const path of under(folder)) {
      if (path === skillPath) continue;
      const relative = folder === "" ? path : path.slice(folder.length + 1);
      const segments = relative.split("/");
      if (segments.some((segment) => segment.startsWith("."))) continue;
      // A root skill's folder is the plugin: only its subfolders that are not
      // other components hold the skill's resources.
      if (
        folder === "" &&
        (segments.length === 1 || componentFolders.has(segments[0] ?? ""))
      ) {
        continue;
      }
      const mediaType = resourceMediaTypes.get(extension(path));
      if (mediaType === undefined) {
        skip(path, "The file is not a text resource.");
        continue;
      }
      if (
        relative.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relative)
      ) {
        skip(path, "The file name has unsupported characters.");
        continue;
      }
      if (resources.length >= MAX_SKILL_RESOURCE_FILES) {
        skip(
          path,
          `The skill has more than ${MAX_SKILL_RESOURCE_FILES} resource files.`,
        );
        continue;
      }
      const content = yield* read(path, MAX_SKILL_FILE_BYTES);
      if (!content.ok) {
        skip(path, content.reason);
        continue;
      }
      const bytes = encoder.encode(content.text).byteLength;
      if (skillBytes + bytes > MAX_SKILL_TOTAL_BYTES) {
        skip(
          path,
          `The skill is larger than ${MAX_SKILL_TOTAL_BYTES.toLocaleString("en-US")} bytes.`,
        );
        continue;
      }
      skillBytes += bytes;
      resources.push({ path: relative, mediaType, content: content.text });
    }
    const preview = yield* previewSkillContent({
      name: rawName,
      description: truncate(skillDescription, 1_024),
      instructions,
      resources,
      source: {
        type: "browser-files",
        label: truncate(`Plugin ${name.value}`, 128),
      },
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SkillImportRejected", (rejection: SkillImportRejected) =>
        Effect.sync(() => {
          skip(skillPath, rejection.reason);
          return Option.none<SkillPreview>();
        }),
      ),
    );
    if (Option.isSome(preview)) skills.push(preview.value);
  }

  // Commands are Claude Code's own slash commands; dx plugins add skills and
  // MCP servers, which work the same in dx and Claude Code Threads.
  if (under("commands").length > 0) skip("commands/", commandsReason);
  if (manifest.commands !== undefined) {
    skip("plugin.json#commands", commandsReason);
  }

  // MCP servers: remote streamable HTTP servers only.
  const mcpConfigs: Array<{ readonly label: string; readonly value: unknown }> =
    [];
  const readJsonConfig = Effect.fn("readClaudeBundle.readJsonConfig")(
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
        skip(label, "Local (stdio) MCP servers are not supported.");
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
      let authType: PluginBundleMcpServer["authType"] = "none";
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

  if (skills.length + mcpServers.length === 0) {
    const first = skipped[0];
    return yield* reject(
      first === undefined
        ? "The bundle has nothing dx can import: no skills or remote MCP servers."
        : `The bundle has nothing dx can import. ${first.path}: ${first.reason}`,
    );
  }

  const byName = <A extends { readonly name: string }>(
    values: ReadonlyArray<A>,
  ) => [...values].sort((left, right) => left.name.localeCompare(right.name));

  const bundleManifest = yield* Schema.decodeUnknownEffect(
    PluginBundleManifest,
  )({
    format: "claude-code",
    name: name.value,
    displayName,
    description,
    ...(declaredVersion === undefined ? {} : { version: declaredVersion }),
    skills: byName(
      skills.map(({ manifest: skill }) => ({
        name: skill.name,
        description: skill.description,
      })),
    ),
    mcpServers,
    skipped,
  }).pipe(
    Effect.mapError(
      () =>
        new PluginBundleRejected({
          reason: "The bundle has more items than dx imports at once.",
        }),
    ),
  );
  const integrity = yield* Effect.promise(() =>
    sha256(
      JSON.stringify({
        manifest: bundleManifest,
        skills: byName(
          skills.map(({ manifest: skill, integrity: skillIntegrity }) => ({
            name: skill.name,
            integrity: skillIntegrity,
          })),
        ),
      }),
    ),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PluginIntegrity)));
  const core = semverCore.exec(declaredVersion ?? "")?.[0];
  const version = yield* Schema.decodeUnknownEffect(PluginVersion)(
    `${core !== undefined && core.length <= 48 ? core : "0.0.0"}+${integrity.slice(0, 12)}`,
  );
  return {
    manifest: bundleManifest,
    skills,
    integrity,
    version,
  } satisfies ParsedBundle;
});
