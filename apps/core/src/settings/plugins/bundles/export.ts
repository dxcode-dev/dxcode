import {
  isStdioMcpServer,
  type PluginBundleManifest,
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

/**
 * The manifest's `panes`: the declared panes (icons as paths), each with
 * the `connect` read for it, and any pane that only has a `connect`.
 */
const exportPanes = (
  code: NonNullable<PluginBundleManifest["code"]>,
  itemPath: (icon: string) => string,
) => {
  const connectOf = (id: string) => {
    const found = code.paneConnect?.find(({ pane }) => pane === id);
    return found === undefined
      ? undefined
      : {
          hosts: found.hosts,
          portal: found.portal,
          ...(found.webrtc === true ? { webrtc: true } : {}),
        };
  };
  const declared = (code.panes ?? []).map((pane) => {
    const connect = connectOf(pane.id);
    return {
      ...pane,
      ...(pane.icon === undefined ? {} : { icon: itemPath(pane.icon) }),
      ...(connect === undefined ? {} : { connect }),
    };
  });
  const connectOnly = (code.paneConnect ?? [])
    .filter(({ pane }) => !declared.some(({ id }) => id === pane))
    .map(({ pane }) => ({ id: pane, connect: connectOf(pane) }));
  return [...declared, ...connectOnly];
};

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
  /** The icon files the manifest names, by hash, from `plugin_icon`. */
  readonly iconFiles?: ReadonlyMap<string, ExportIconFile>;
}): ReadonlyArray<ZipFile> => {
  const { bundle } = input;
  const { manifest } = bundle;
  const icons = exportIcons(manifest, input.iconFiles);
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
          ? icons.block === undefined
            ? {}
            : { extensions: { "dev.dxcode": { icon: icons.block } } }
          : {
              extensions: {
                "dev.dxcode": {
                  apiVersion: manifest.code.apiVersion,
                  // With hosts, entry is written only as the Worker's
                  // module, so a re-import reads the same hosts back.
                  ...(manifest.code.hosts !== undefined &&
                  manifest.code.hosts.worker === undefined
                    ? {}
                    : { entry: manifest.code.entry }),
                  host: manifest.code.hosts ?? manifest.code.host,
                  permissions: manifest.code.permissions,
                  ...(manifest.code.settings.length === 0
                    ? {}
                    : { settings: manifest.code.settings }),
                  ...(manifest.code.agentModes === undefined
                    ? {}
                    : { agentModes: manifest.code.agentModes }),
                  ...(manifest.code.tier === undefined
                    ? {}
                    : { tier: manifest.code.tier }),
                  ...(manifest.code.binaries === undefined
                    ? {}
                    : { binaries: manifest.code.binaries }),
                  ...(icons.block === undefined ? {} : { icon: icons.block }),
                  ...(manifest.code.archivedThreads === undefined
                    ? {}
                    : { archivedThreads: manifest.code.archivedThreads }),
                  // Declared panes, with each one's connect.
                  ...(manifest.code.panes === undefined &&
                  manifest.code.paneConnect === undefined
                    ? {}
                    : { panes: exportPanes(manifest.code, icons.itemPath) }),
                  ...(manifest.code.durableScope === undefined
                    ? {}
                    : { durableScope: manifest.code.durableScope }),
                  ...(manifest.code.jobs === undefined
                    ? {}
                    : { jobs: manifest.code.jobs }),
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
  if (manifest.icon !== undefined && icons.files.length === 0) {
    files.push({
      path:
        manifest.icon.mediaType === "image/png" ? PNG_ICON_PATH : SVG_ICON_PATH,
      content: iconBytes(manifest.icon),
    });
  }
  files.push(...icons.files);
  const written = new Set(files.map(({ path }) => path));
  for (const file of input.packageFiles ?? []) {
    const generated =
      file.path === "plugin.json" ||
      file.path === "mcp.json" ||
      file.path.startsWith("skills/") ||
      file.path === PNG_ICON_PATH ||
      file.path === SVG_ICON_PATH ||
      written.has(file.path) ||
      // The source's signature covers its files, not the export's.
      file.path === "plugin.sig";
    if (!generated && !written.has(file.path)) files.push(file);
  }
  return files;
};

// --- Icon files ---

export interface ExportIconFile {
  readonly mediaType: "image/png" | "image/svg+xml";
  readonly bytes: Uint8Array;
}

const extensionOf = (file: ExportIconFile) =>
  file.mediaType === "image/png" ? "png" : "svg";

/**
 * The icon block and files an export writes: the icon set under
 * `assets/icon*.{svg,png}`, and every item icon file at the path the code
 * names it by, so a re-import resolves the same icons.
 */
const exportIcons = (
  manifest: StoredPluginBundle["manifest"],
  stored: ReadonlyMap<string, ExportIconFile> | undefined,
) => {
  const files: Array<ZipFile> = [];
  const byHash = new Map<string, string>();
  for (const [path, hash] of Object.entries(manifest.code?.iconAssets ?? {})) {
    const file = stored?.get(hash);
    if (file === undefined) continue;
    files.push({ path, content: file.bytes });
    if (!byHash.has(hash)) byHash.set(hash, path);
  }
  const named = (hash: string | undefined, base: string) => {
    if (hash === undefined) return undefined;
    const known = byHash.get(hash);
    if (known !== undefined) return known;
    const file = stored?.get(hash);
    if (file === undefined) return undefined;
    const path = `assets/${base}.${extensionOf(file)}`;
    files.push({ path, content: file.bytes });
    byHash.set(hash, path);
    return path;
  };
  const set = manifest.iconSet;
  const src = named(set?.src, "icon");
  const dark = named(set?.dark, "icon-dark");
  const monochrome = named(set?.monochrome, "icon-mono");
  const block =
    src === undefined && dark === undefined && monochrome === undefined
      ? undefined
      : {
          ...(src === undefined ? {} : { src }),
          ...(dark === undefined ? {} : { dark }),
          ...(monochrome === undefined ? {} : { monochrome }),
          ...(set?.background === undefined
            ? {}
            : { background: set.background }),
        };
  return {
    block,
    files,
    /** An item icon as written: `lucide:` as is, a hash as its file path. */
    itemPath: (icon: string) => byHash.get(icon) ?? icon,
  };
};

/** Every icon hash an export writes. */
export const exportIconHashes = (manifest: StoredPluginBundle["manifest"]) => [
  ...new Set(
    [
      manifest.iconSet?.src,
      manifest.iconSet?.dark,
      manifest.iconSet?.monochrome,
      ...Object.values(manifest.code?.iconAssets ?? {}),
    ].filter((hash): hash is string => hash !== undefined),
  ),
];

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
