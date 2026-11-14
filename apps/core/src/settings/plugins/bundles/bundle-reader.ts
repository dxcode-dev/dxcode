import {
  MAX_PLUGIN_BUNDLE_SKIPPED,
  MAX_PLUGIN_BUNDLE_TEXT_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_INSTRUCTIONS_BYTES,
  MAX_SKILL_RESOURCE_FILES,
  MAX_SKILL_TOTAL_BYTES,
  MAX_SKILLS_PER_SCOPE,
  PluginBundleManifest,
  type PluginBundleMcpServer,
  type PluginBundlePackage,
  type PluginBundleSkipped,
  PluginIntegrity,
  PluginVersion,
  SkillName,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import YAML from "yaml";
import {
  previewSkillContent,
  type SkillImportRejected,
  type SkillPreview,
} from "../../skills/import.js";
import type { PluginCodeModule, ReadPluginCode } from "./dx-extension.js";
import { PluginBundleRejected } from "./errors.js";
import {
  type PluginIconFile,
  readPluginIcon,
  readPluginIconSet,
} from "./plugin-icon.js";
import type { ZipArchive, ZipBytes, ZipEntry, ZipText } from "./zip.js";

/**
 * What every plugin format reader shares: the plugin's files inside an
 * archive, bounded text reads, the skipped list, skill folders turned into
 * skill previews, and the final manifest with its integrity.
 */

export interface ParsedBundle {
  readonly manifest: PluginBundleManifest;
  /** The code layer's JavaScript modules, stored with the version. */
  readonly codeModules: ReadonlyArray<PluginCodeModule>;
  readonly skills: ReadonlyArray<SkillPreview>;
  readonly integrity: PluginIntegrity;
  readonly version: PluginVersion;
  /** The plugin's files for the Orb, when a local MCP server needs them. */
  readonly packageBytes?: Uint8Array;
  /** Icon files to store in `plugin_icon` by hash. */
  readonly iconFiles?: ReadonlyArray<PluginIconFile>;
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

export const reject = (reason: string) =>
  Effect.fail(new PluginBundleRejected({ reason }));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The note for a manifest field dx does not read. */
export const NOT_A_DX_FIELD = "Not a dx field; ignored.";

/**
 * Notes every key of `raw` outside `known` as skipped under `label`, so a
 * typo inside an entry is reported instead of acting as the default.
 */
export const skipUnknownFields = (
  skip: (path: string, reason: string) => void,
  raw: unknown,
  known: ReadonlyArray<string>,
  label: string,
) => {
  if (!isRecord(raw)) return;
  for (const key of Object.keys(raw))
    if (!known.includes(key)) skip(`${label}.${key}`, NOT_A_DX_FIELD);
};

export const truncate = (value: string, maximum: number) =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

export const join = (directory: string, name: string) =>
  directory === "" ? name : `${directory}/${name}`;

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

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

/** A path relative to the plugin root, or "outside". */
export const manifestPath = (raw: string): string | "outside" => {
  let path = raw.trim();
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return "outside";
  }
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/, "");
  if (path === "." || path === "") return "";
  return path.split("/").some((segment) => segment === "..") ? "outside" : path;
};

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

const semverCore =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

/** Finds the plugin folder: GitHub archives wrap everything in one folder. */
const topFolder = (entries: ReadonlyArray<ZipEntry>): string => {
  const first = entries[0]?.path.split("/")[0];
  if (first === undefined) return "";
  const prefix = `${first}/`;
  return entries.every(({ path }) => path.startsWith(prefix)) ? prefix : "";
};

/** The plugin's files inside an archive, with bounded reads. */
export interface BundleFolder {
  /** The plugin folder inside the repository, for messages. */
  readonly root: string;
  readonly files: ReadonlyMap<string, ZipEntry>;
  readonly paths: ReadonlyArray<string>;
  /** Every file below a folder; every file for the root. */
  readonly under: (directory: string) => ReadonlyArray<string>;
  /** Reads a file as text, counting it toward the bundle's text limit. */
  readonly read: (
    path: string,
    maxBytes: number,
  ) => Effect.Effect<ZipText, PluginBundleRejected>;
  /** Reads a file without counting it, for files that are not imported. */
  readonly peek: (
    path: string,
    maxBytes: number,
  ) => Effect.Effect<ZipText, PluginBundleRejected>;
  /** Reads a binary file without counting it, such as the icon. */
  readonly peekBytes: (
    path: string,
    maxBytes: number,
  ) => Effect.Effect<ZipBytes, PluginBundleRejected>;
  readonly skipped: ReadonlyArray<PluginBundleSkipped>;
  readonly skip: (path: string, reason: string) => void;
}

export const openBundleFolder = Effect.fn("openBundleFolder")(function* (
  archive: ZipArchive,
  rootOption: string,
) {
  const top = topFolder(archive.entries);
  const root = manifestPath(rootOption);
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
  const read = Effect.fn("BundleFolder.read")(function* (
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
  const peek = (
    path: string,
    maxBytes: number,
  ): Effect.Effect<ZipText, PluginBundleRejected> => {
    const entry = files.get(path);
    return entry === undefined
      ? Effect.succeed({ ok: false, reason: "The file is missing." })
      : archive.readText(entry, maxBytes);
  };
  const peekBytes = (
    path: string,
    maxBytes: number,
  ): Effect.Effect<ZipBytes, PluginBundleRejected> => {
    const entry = files.get(path);
    return entry === undefined
      ? Effect.succeed({ ok: false, reason: "The file is missing." })
      : archive.readBytes(entry, maxBytes);
  };

  const skipped: Array<PluginBundleSkipped> = [];
  const skip = (path: string, reason: string) => {
    if (skipped.length < MAX_PLUGIN_BUNDLE_SKIPPED) {
      skipped.push({
        path: truncate(path, 256),
        reason: truncate(reason, 256),
      });
    }
  };

  return {
    root,
    files,
    paths,
    under,
    read,
    peek,
    peekBytes,
    skipped,
    skip,
  } satisfies BundleFolder;
});

/**
 * Reads each skill folder's SKILL.md and text resources into a skill preview.
 * A skill that cannot be imported is skipped with a reason; the rest load.
 */
export const readSkillFolders = Effect.fn("readSkillFolders")(function* (
  folder: BundleFolder,
  skillFolders: ReadonlyArray<string>,
  options: {
    readonly pluginName: string;
    /** Folders below a root skill that hold other components, not resources. */
    readonly componentFolders: ReadonlySet<string>;
    /** Agent Skills requires a skill's name to match its folder. */
    readonly requireFolderName: boolean;
  },
) {
  const skills: Array<SkillPreview> = [];
  for (const skillFolder of skillFolders) {
    const skillPath = join(skillFolder, "SKILL.md");
    if (skills.length >= MAX_SKILLS_PER_SCOPE) {
      folder.skip(skillPath, "The bundle has too many skills.");
      continue;
    }
    const text = yield* folder.read(
      skillPath,
      MAX_SKILL_INSTRUCTIONS_BYTES * 2,
    );
    if (!text.ok) {
      folder.skip(
        skillPath,
        text.reason.startsWith("The file is larger")
          ? `The instructions are longer than ${MAX_SKILL_INSTRUCTIONS_BYTES.toLocaleString("en-US")} bytes.`
          : text.reason,
      );
      continue;
    }
    const { data, body } = frontMatter(text.text);
    const folderName =
      skillFolder === ""
        ? options.pluginName
        : basename(skillFolder).toLowerCase();
    const rawName =
      typeof data.name === "string"
        ? data.name.trim().toLowerCase()
        : folderName;
    if (Option.isNone(Schema.decodeOption(SkillName)(rawName))) {
      folder.skip(
        skillPath,
        `The skill name must be kebab-case, not ${JSON.stringify(truncate(rawName, 64))}.`,
      );
      continue;
    }
    if (
      options.requireFolderName &&
      (typeof data.name !== "string" ||
        data.name !== rawName ||
        data.name !== basename(skillFolder))
    ) {
      folder.skip(
        skillPath,
        `The skill's name must be lowercase and match its folder, ${basename(skillFolder)}.`,
      );
      continue;
    }
    if (skills.some(({ manifest }) => manifest.name === rawName)) {
      folder.skip(skillPath, `Another skill is already named ${rawName}.`);
      continue;
    }
    const skillDescription =
      typeof data.description === "string" ? data.description.trim() : "";
    if (skillDescription === "") {
      folder.skip(skillPath, "SKILL.md has no description.");
      continue;
    }
    const instructions = body.trim();
    if (instructions === "") {
      folder.skip(skillPath, "SKILL.md has no instructions.");
      continue;
    }
    if (
      encoder.encode(instructions).byteLength > MAX_SKILL_INSTRUCTIONS_BYTES
    ) {
      folder.skip(
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
    for (const path of folder.under(skillFolder)) {
      if (path === skillPath) continue;
      const relative =
        skillFolder === "" ? path : path.slice(skillFolder.length + 1);
      const segments = relative.split("/");
      if (segments.some((segment) => segment.startsWith("."))) continue;
      // A root skill's folder is the plugin: only its subfolders that are not
      // other components hold the skill's resources.
      if (
        skillFolder === "" &&
        (segments.length === 1 ||
          options.componentFolders.has(segments[0] ?? ""))
      ) {
        continue;
      }
      const mediaType = resourceMediaTypes.get(extension(path));
      if (mediaType === undefined) {
        folder.skip(path, "The file is not a text resource.");
        continue;
      }
      if (
        relative.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relative)
      ) {
        folder.skip(path, "The file name has unsupported characters.");
        continue;
      }
      if (resources.length >= MAX_SKILL_RESOURCE_FILES) {
        folder.skip(
          path,
          `The skill has more than ${MAX_SKILL_RESOURCE_FILES} resource files.`,
        );
        continue;
      }
      const content = yield* folder.read(path, MAX_SKILL_FILE_BYTES);
      if (!content.ok) {
        folder.skip(path, content.reason);
        continue;
      }
      const bytes = encoder.encode(content.text).byteLength;
      if (skillBytes + bytes > MAX_SKILL_TOTAL_BYTES) {
        folder.skip(
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
        label: truncate(`Plugin ${options.pluginName}`, 128),
      },
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SkillImportRejected", (rejection: SkillImportRejected) =>
        Effect.sync(() => {
          folder.skip(skillPath, rejection.reason);
          return Option.none<SkillPreview>();
        }),
      ),
    );
    if (Option.isSome(preview)) skills.push(preview.value);
  }
  return skills;
});

/** Builds the stored manifest, its integrity, and dx's version for it. */
export const finishBundle = Effect.fn("finishBundle")(function* (
  folder: BundleFolder,
  input: {
    readonly format: PluginBundleManifest["format"];
    readonly name: string;
    readonly displayName: string;
    readonly description: string;
    readonly declaredVersion: string | undefined;
    readonly skills: ReadonlyArray<SkillPreview>;
    readonly mcpServers: ReadonlyArray<PluginBundleMcpServer>;
    readonly code?: ReadPluginCode | undefined;
    /** `extensions["dev.dxcode"].icon` as written, when there is one. */
    readonly iconBlock?: unknown;
    /** The plugin's files, kept when a local MCP server runs from them. */
    readonly package?: {
      readonly bytes: Uint8Array;
      readonly summary: PluginBundlePackage;
    };
  },
) {
  if (
    input.skills.length + input.mcpServers.length === 0 &&
    input.code === undefined
  ) {
    const first = folder.skipped[0];
    return yield* reject(
      first === undefined
        ? "The bundle has nothing dx can import: no skills, MCP servers, or dx code."
        : `The bundle has nothing dx can import. ${first.path}: ${first.reason}`,
    );
  }

  const icon = yield* readPluginIcon(folder);
  const iconSet = yield* readPluginIconSet(folder, input.iconBlock, icon);
  const iconFiles = [...iconSet.files, ...(input.code?.iconFiles ?? [])];
  const byName = <A extends { readonly name: string }>(
    values: ReadonlyArray<A>,
  ) => [...values].sort((left, right) => left.name.localeCompare(right.name));

  const code =
    input.code === undefined
      ? undefined
      : {
          apiVersion: input.code.apiVersion,
          host: input.code.host,
          entry: input.code.entry,
          ...(input.code.hosts === undefined
            ? {}
            : { hosts: input.code.hosts }),
          ...(input.code.durableScope === undefined
            ? {}
            : { durableScope: input.code.durableScope }),
          ...(input.code.jobs === undefined ? {} : { jobs: input.code.jobs }),
          modules: yield* Effect.promise(() =>
            Promise.all(
              (input.code?.modules ?? []).map(async ({ path, content }) => ({
                path,
                bytes: encoder.encode(content).byteLength,
                integrity: await sha256(content),
              })),
            ),
          ),
          permissions: input.code.permissions,
          settings: input.code.settings,
          ...(input.code.agentModes === undefined
            ? {}
            : { agentModes: input.code.agentModes }),
          ...(input.code.tier === undefined ? {} : { tier: input.code.tier }),
          ...(input.code.binaries === undefined
            ? {}
            : { binaries: input.code.binaries }),
          ...(input.code.archivedThreads === undefined
            ? {}
            : { archivedThreads: input.code.archivedThreads }),
          ...(input.code.panes === undefined
            ? {}
            : { panes: input.code.panes }),
          ...(input.code.iconAssets === undefined
            ? {}
            : { iconAssets: input.code.iconAssets }),
          ...(input.code.views === undefined
            ? {}
            : { views: input.code.views }),
          ...(input.code.exports === undefined
            ? {}
            : { exports: input.code.exports }),
          // Panes[].connect.
          ...(input.code.paneConnect === undefined
            ? {}
            : { paneConnect: input.code.paneConnect }),
        };
  const bundleManifest = yield* Schema.decodeUnknownEffect(
    PluginBundleManifest,
  )({
    format: input.format,
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    ...(input.declaredVersion === undefined
      ? {}
      : { version: input.declaredVersion }),
    skills: byName(
      input.skills.map(({ manifest: skill }) => ({
        name: skill.name,
        description: skill.description,
      })),
    ),
    mcpServers: input.mcpServers,
    ...(code === undefined ? {} : { code }),
    skipped: folder.skipped,
    ...(icon === undefined ? {} : { icon }),
    ...(iconSet.set === undefined ? {} : { iconSet: iconSet.set }),
    ...(input.package === undefined ? {} : { package: input.package.summary }),
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
          input.skills.map(
            ({ manifest: skill, integrity: skillIntegrity }) => ({
              name: skill.name,
              integrity: skillIntegrity,
            }),
          ),
        ),
      }),
    ),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PluginIntegrity)));
  const core = semverCore.exec(input.declaredVersion ?? "")?.[0];
  const version = yield* Schema.decodeUnknownEffect(PluginVersion)(
    `${core !== undefined && core.length <= 48 ? core : "0.0.0"}+${integrity.slice(0, 12)}`,
  );
  return {
    manifest: bundleManifest,
    skills: input.skills,
    codeModules: input.code?.modules ?? [],
    integrity,
    version,
    ...(input.package === undefined
      ? {}
      : { packageBytes: input.package.bytes }),
    ...(iconFiles.length === 0 ? {} : { iconFiles }),
  } satisfies ParsedBundle;
});
