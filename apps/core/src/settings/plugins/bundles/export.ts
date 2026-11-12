import {
  isStdioMcpServer,
  type PluginCodeModuleContent,
  type SkillWithVersion,
  type StoredMcpServer,
  type StoredPluginBundle,
} from "@dx/domain";
import YAML from "yaml";
import { iconBytes, PNG_ICON_PATH, SVG_ICON_PATH } from "./plugin-icon.js";
import { writeZip, type ZipFile } from "./zip-writer.js";

/**
 * Exports an installed plugin as an Agent Plugins 1.1.0 package
 * (https://agent-plugins.org): the root `plugin.json`, each skill's active
 * version in `skills/<name>/`, its MCP servers in `mcp.json`, the icon in
 * `assets/`, dx's code layer under `dev.dxcode/`, and, for a plugin with a
 * local (stdio) server, the plugin's own files that server runs. It holds what dx runs now, including edits made after
 * import. Secrets stay behind: a secret header, a stored token, and OAuth
 * settings never leave dx. Any Agent Plugins client, dx included, can import
 * the ZIP.
 */

export const EXPORT_SPEC_VERSION = "1.1.0";

const pluginSchema = `https://agent-plugins.org/schemas/${EXPORT_SPEC_VERSION}/plugin.schema.json`;
const mcpSchema = `https://agent-plugins.org/schemas/${EXPORT_SPEC_VERSION}/mcp.schema.json`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const skillMarkdown = ({ active }: SkillWithVersion) =>
  `---\n${YAML.stringify(
    { name: active.manifest.name, description: active.manifest.description },
    { lineWidth: 0 },
  )}---\n\n${active.instructions.trim()}\n`;

export const pluginExportFiles = (input: {
  readonly bundle: StoredPluginBundle;
  readonly skills: ReadonlyArray<SkillWithVersion>;
  readonly mcpServers: ReadonlyArray<StoredMcpServer>;
  /** The code layer's modules, when the plugin has code. */
  readonly codeModules?: ReadonlyArray<PluginCodeModuleContent>;
  /**
   * The plugin's own files, kept for its local (stdio) MCP servers. Files
   * at paths the export writes itself are left out.
   */
  readonly packageFiles?: ReadonlyArray<ZipFile>;
}): ReadonlyArray<ZipFile> => {
  const { bundle } = input;
  const { manifest } = bundle;
  const files: Array<ZipFile> = [
    {
      path: "plugin.json",
      content: json({
        $schema: pluginSchema,
        name: bundle.name,
        ...(manifest.displayName === bundle.name
          ? {}
          : { displayName: manifest.displayName }),
        ...(manifest.version === undefined
          ? {}
          : { version: manifest.version }),
        ...(manifest.description === ""
          ? {}
          : { description: manifest.description }),
        ...(manifest.code === undefined
          ? {}
          : {
              extensions: {
                "dev.dxcode": {
                  apiVersion: manifest.code.apiVersion,
                  entry: manifest.code.entry,
                  host: manifest.code.host,
                  permissions: manifest.code.permissions,
                  ...(manifest.code.settings.length === 0
                    ? {}
                    : { settings: manifest.code.settings }),
                  ...(manifest.code.agentModes === undefined
                    ? {}
                    : { agentModes: manifest.code.agentModes }),
                },
              },
            }),
      }),
    },
  ];
  // dx's code layer, as it was reviewed and stored.
  for (const module of input.codeModules ?? [])
    files.push({ path: module.path, content: module.content });
  const skills = [...input.skills].sort((left, right) =>
    left.skill.name.localeCompare(right.skill.name),
  );
  for (const skill of skills) {
    const folder = `skills/${skill.skill.name}`;
    files.push({ path: `${folder}/SKILL.md`, content: skillMarkdown(skill) });
    for (const resource of skill.active.resources) {
      files.push({
        path: `${folder}/${resource.path}`,
        content: resource.content,
      });
    }
  }
  const servers = [...input.mcpServers].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const localServers = manifest.mcpServers
    .filter(isStdioMcpServer)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  if (servers.length + localServers.length > 0) {
    files.push({
      path: "mcp.json",
      content: json({
        $schema: mcpSchema,
        mcpServers: Object.fromEntries([
          ...servers.map((server) => {
            const headers = server.headers.filter(
              (header) => !header.secret && header.value !== undefined,
            );
            return [
              server.name,
              {
                type: "streamable-http",
                url: server.endpoint,
                ...(headers.length === 0
                  ? {}
                  : {
                      headers: Object.fromEntries(
                        headers.map(({ name, value }) => [name, value]),
                      ),
                    }),
              },
            ];
          }),
          ...localServers.map((server) => [
            server.name,
            {
              type: "stdio",
              command: server.command,
              ...(server.args.length === 0 ? {} : { args: server.args }),
              ...(server.env.length === 0
                ? {}
                : {
                    env: Object.fromEntries(
                      server.env.map(({ name, value }) => [name, value]),
                    ),
                  }),
              ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
            },
          ]),
        ]),
      }),
    });
  }
  if (manifest.icon !== undefined) {
    files.push({
      path:
        manifest.icon.mediaType === "image/png" ? PNG_ICON_PATH : SVG_ICON_PATH,
      content: iconBytes(manifest.icon),
    });
  }
  const written = new Set(files.map(({ path }) => path));
  for (const file of input.packageFiles ?? []) {
    const generated =
      file.path === "plugin.json" ||
      file.path === "mcp.json" ||
      file.path.startsWith("skills/") ||
      file.path === PNG_ICON_PATH ||
      file.path === SVG_ICON_PATH ||
      // The source's signature covers its files, not the export's.
      file.path === "plugin.sig";
    if (!generated && !written.has(file.path)) files.push(file);
  }
  return files;
};

export const exportPluginBundle = async (
  input: Parameters<typeof pluginExportFiles>[0],
  /** Signs the files, for a `plugin.sig` beside them. */
  sign?: (files: ReadonlyArray<ZipFile>) => Promise<string>,
) => {
  const files = pluginExportFiles(input);
  return {
    filename: `${input.bundle.name}.zip`,
    bytes: await writeZip(
      sign === undefined
        ? files
        : [...files, { path: "plugin.sig", content: await sign(files) }],
    ),
  };
};
