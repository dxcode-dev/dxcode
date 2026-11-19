import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_INSTRUCTIONS_BYTES,
  MAX_SKILL_MANIFEST_BYTES,
  MAX_SKILL_RESOURCE_FILES,
  MAX_SKILL_TOTAL_BYTES,
  SkillImportBundle,
  SkillInstructions,
  SkillIntegrity,
  SkillManifest,
  SkillResource,
  SkillResourcePath,
  type SkillSource,
  type StoredSkillVersion,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import {
  binaryBrowserMediaType,
  frontMatter,
  skillFileMediaType,
} from "./skill-files.js";

const textEncoder = new TextEncoder();

export class SkillImportRejected extends Schema.TaggedError<SkillImportRejected>()(
  "SkillImportRejected",
  { field: Schema.String, reason: Schema.String },
) {}

export interface SkillPreview {
  readonly manifest: typeof SkillManifest.Type;
  readonly instructions: typeof SkillInstructions.Type;
  readonly resources: ReadonlyArray<typeof SkillResource.Type>;
  readonly source: SkillSource;
  readonly integrity: typeof SkillIntegrity.Type;
  readonly totalBytes: number;
}

const reject = (field: string, reason: string) =>
  Effect.fail(new SkillImportRejected({ field, reason }));

const sha256 = async (value: string | Uint8Array): Promise<string> => {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const checkedText = (value: string, path: string, maximumBytes: number) => {
  if (value.includes("\0") || value.includes("\uFFFD")) {
    return reject(path, "Only valid UTF-8 text without NUL bytes is allowed.");
  }
  const bytes = textEncoder.encode(value).byteLength;
  return bytes > maximumBytes
    ? reject(
        path,
        `File exceeds the ${maximumBytes.toLocaleString()} byte limit.`,
      )
    : Effect.succeed(bytes);
};

const safePath = (path: string) => {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /%(?:2e|2f|5c)/i.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return (
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith("."),
    ) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)
  );
};

const canonicalPayload = (preview: {
  readonly manifest: typeof SkillManifest.Type;
  readonly instructions: string;
  readonly resources: ReadonlyArray<{
    readonly path: string;
    readonly mediaType: string;
    readonly content: string;
  }>;
}) =>
  JSON.stringify({
    manifest: {
      schemaVersion: preview.manifest.schemaVersion,
      name: preview.manifest.name,
      description: preview.manifest.description,
      mcpServerIds: [...preview.manifest.mcpServerIds].sort(),
    },
    instructions: preview.instructions,
    resources: [...preview.resources]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, mediaType, content }) => ({ path, mediaType, content })),
  });

/** A skill's files as an importer read them, before any checks. */
export interface SkillFileInput {
  readonly path: string;
  readonly content: string;
}

/**
 * The manifest and instructions of a skill's files, in either layout: a
 * standard Agent Skills folder (`SKILL.md` with `name` and `description`
 * front matter), or dx's own (`skill.json` and `instructions.md`).
 */
const readSkillDocument = Effect.fn("readSkillDocument")(function* (
  files: ReadonlyArray<SkillFileInput>,
) {
  const skillMd = files.find(({ path }) => path === "SKILL.md");
  const manifestFile = files.find(({ path }) => path === "skill.json");
  const instructionsFile = files.find(({ path }) => path === "instructions.md");
  if (manifestFile === undefined && skillMd !== undefined) {
    yield* checkedText(
      skillMd.content,
      "SKILL.md",
      MAX_SKILL_INSTRUCTIONS_BYTES * 2,
    );
    const { data, body } = frontMatter(skillMd.content);
    const manifest = yield* Schema.decodeUnknownEffect(SkillManifest)({
      schemaVersion: 1,
      name: typeof data.name === "string" ? data.name.trim().toLowerCase() : "",
      description:
        typeof data.description === "string" ? data.description.trim() : "",
    }).pipe(
      Effect.mapError(
        () =>
          new SkillImportRejected({
            field: "SKILL.md",
            reason:
              "SKILL.md front matter needs a kebab-case name and a description of up to 1,024 characters.",
          }),
      ),
    );
    const instructions = yield* decodeInstructions(body.trim(), "SKILL.md");
    return { manifest, instructions, documents: ["SKILL.md"] };
  }
  if (manifestFile === undefined) {
    return yield* reject(
      "SKILL.md",
      "Add a SKILL.md with name and description front matter.",
    );
  }
  if (instructionsFile === undefined) {
    return yield* reject(
      "instructions.md",
      "The skill instruction document is required.",
    );
  }
  yield* checkedText(
    manifestFile.content,
    "skill.json",
    MAX_SKILL_MANIFEST_BYTES,
  );
  yield* checkedText(
    instructionsFile.content,
    "instructions.md",
    MAX_SKILL_INSTRUCTIONS_BYTES,
  );
  const rawManifest = yield* Effect.try({
    try: () => JSON.parse(manifestFile.content) as unknown,
    catch: () =>
      new SkillImportRejected({
        field: "skill.json",
        reason: "Manifest must be valid JSON.",
      }),
  });
  const manifest = yield* Schema.decodeUnknownEffect(SkillManifest)(
    rawManifest,
    { onExcessProperty: "error" },
  ).pipe(
    Effect.mapError(
      () =>
        new SkillImportRejected({
          field: "skill.json",
          reason:
            "Use schemaVersion 1, a kebab-case name, description, and optional reviewed MCP server IDs.",
        }),
    ),
  );
  const instructions = yield* decodeInstructions(
    instructionsFile.content.trim(),
    "instructions.md",
  );
  return {
    manifest,
    instructions,
    documents: ["skill.json", "instructions.md"],
  };
});

const decodeInstructions = (value: string, field: string) =>
  Schema.decodeUnknownEffect(SkillInstructions)(value).pipe(
    Effect.mapError(
      () =>
        new SkillImportRejected({
          field,
          reason: `Instructions must contain 1–${MAX_SKILL_INSTRUCTIONS_BYTES.toLocaleString("en-US")} characters.`,
        }),
    ),
  );

/**
 * Checks a skill's files and builds its preview. Every file besides the
 * skill's documents is a resource at its path in the folder, so a skill's
 * scripts/, references/, and assets/ stay where its instructions expect
 * them. Any UTF-8 text file is allowed; binary files are not.
 */
export const previewSkillFiles = Effect.fn("previewSkillFiles")(function* (
  files: ReadonlyArray<SkillFileInput>,
  source: SkillSource,
) {
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (!safePath(file.path)) {
      return yield* reject(
        file.path,
        "Paths must be safe relative paths without traversal or hidden segments.",
      );
    }
    if (paths.has(file.path)) {
      return yield* reject(file.path, "Duplicate paths are not allowed.");
    }
    paths.add(file.path);
    totalBytes += yield* checkedText(
      file.content,
      file.path,
      MAX_SKILL_FILE_BYTES,
    );
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      return yield* reject(
        "files",
        `The skill exceeds the ${MAX_SKILL_TOTAL_BYTES.toLocaleString("en-US")} byte limit.`,
      );
    }
  }
  const { manifest, instructions, documents } = yield* readSkillDocument(files);
  const resourceFiles = files.filter(({ path }) => !documents.includes(path));
  if (resourceFiles.length > MAX_SKILL_RESOURCE_FILES) {
    return yield* reject(
      "resources",
      `Use at most ${MAX_SKILL_RESOURCE_FILES} files besides the instructions.`,
    );
  }
  const resources = yield* Effect.all(
    resourceFiles.map((file) =>
      Effect.gen(function* () {
        const mediaType = skillFileMediaType(file.path);
        if (mediaType === undefined) {
          return yield* reject(file.path, "Binary files are not allowed.");
        }
        const path = Schema.decodeOption(SkillResourcePath)(file.path);
        if (Option.isNone(path)) {
          return yield* reject(file.path, "Resource path is too long.");
        }
        const integrity = yield* Effect.promise(() =>
          sha256(file.content),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SkillIntegrity)));
        return yield* Schema.decodeUnknownEffect(SkillResource)({
          path: path.value,
          mediaType,
          content: file.content,
          sizeBytes: textEncoder.encode(file.content).byteLength,
          integrity,
        });
      }),
    ),
  );
  const integrity = yield* Effect.promise(() =>
    sha256(canonicalPayload({ manifest, instructions, resources })),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SkillIntegrity)));

  return {
    manifest,
    instructions,
    resources,
    source,
    integrity,
    totalBytes,
  } satisfies SkillPreview;
});

/** Checks a bundle of files a person chose in the browser. */
export const previewSkillImport = Effect.fn("previewSkillImport")(function* (
  unknownBundle: unknown,
) {
  const bundle = yield* Schema.decodeUnknownEffect(SkillImportBundle)(
    unknownBundle,
    { onExcessProperty: "error" },
  ).pipe(
    Effect.mapError(
      () =>
        new SkillImportRejected({
          field: "files",
          reason: `Use at most ${MAX_SKILL_FILES} UTF-8 text files of up to ${MAX_SKILL_FILE_BYTES.toLocaleString("en-US")} bytes each.`,
        }),
    ),
  );
  for (const file of bundle.files) {
    if (file.kind !== "file") {
      return yield* reject(file.path, "Symlinks are not allowed.");
    }
    if (binaryBrowserMediaType(file.mediaType)) {
      return yield* reject(file.path, "Binary files are not allowed.");
    }
  }
  return yield* previewSkillFiles(bundle.files, bundle.source);
});

/**
 * A skill preview built from content another importer already read and
 * checked, such as a skill inside a plugin bundle. Resource paths keep the
 * layout of the skill's folder.
 */
export const previewSkillContent = Effect.fn("previewSkillContent")(
  function* (input: {
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
    readonly resources: ReadonlyArray<{
      readonly path: string;
      readonly mediaType: string;
      readonly content: string;
    }>;
    readonly source: SkillSource;
  }) {
    const manifest = yield* Schema.decodeUnknownEffect(SkillManifest)({
      schemaVersion: 1,
      name: input.name,
      description: input.description,
    }).pipe(
      Effect.mapError(
        () =>
          new SkillImportRejected({
            field: "SKILL.md",
            reason: "Use a kebab-case name and a description.",
          }),
      ),
    );
    const instructions = yield* Schema.decodeUnknownEffect(SkillInstructions)(
      input.instructions,
    ).pipe(
      Effect.mapError(
        () =>
          new SkillImportRejected({
            field: "SKILL.md",
            reason: `Instructions must contain 1–${MAX_SKILL_INSTRUCTIONS_BYTES.toLocaleString("en-US")} characters.`,
          }),
      ),
    );
    let totalBytes = textEncoder.encode(instructions).byteLength;
    const resources = yield* Effect.all(
      input.resources.map((file) =>
        Effect.gen(function* () {
          const sizeBytes = textEncoder.encode(file.content).byteLength;
          totalBytes += sizeBytes;
          const integrity = yield* Effect.promise(() =>
            sha256(file.content),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SkillIntegrity)));
          return yield* Schema.decodeUnknownEffect(SkillResource)({
            path: file.path,
            mediaType: file.mediaType,
            content: file.content,
            sizeBytes,
            integrity,
          }).pipe(
            Effect.mapError(
              () =>
                new SkillImportRejected({
                  field: file.path,
                  reason: "The resource is too large or its path too long.",
                }),
            ),
          );
        }),
      ),
    );
    if (resources.length > MAX_SKILL_RESOURCE_FILES) {
      return yield* reject(
        "resources",
        `Use at most ${MAX_SKILL_RESOURCE_FILES} resource files.`,
      );
    }
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      return yield* reject(
        "resources",
        `Skill exceeds the ${MAX_SKILL_TOTAL_BYTES.toLocaleString()} byte limit.`,
      );
    }
    const integrity = yield* Effect.promise(() =>
      sha256(canonicalPayload({ manifest, instructions, resources })),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SkillIntegrity)));
    return {
      manifest,
      instructions,
      resources,
      source: input.source,
      integrity,
      totalBytes,
    } satisfies SkillPreview;
  },
);

/**
 * A version as a bundle the browser can import again: dx's layout, which
 * also carries MCP server IDs. Its source becomes browser files, since a
 * re-import is one; the label keeps where it first came from.
 */
export const exportSkillVersion = (
  version: StoredSkillVersion,
  files: ReadonlyArray<typeof SkillResource.Type>,
): SkillImportBundle => ({
  source: {
    type: "browser-files",
    label:
      version.source.type === "github"
        ? `github.com/${version.source.repository}${version.source.path ? `/${version.source.path}` : ""}`.slice(
            0,
            128,
          )
        : version.source.label,
  },
  files: [
    {
      path: "skill.json",
      kind: "file",
      mediaType: "application/json",
      encoding: "utf-8",
      content: `${JSON.stringify(version.manifest, null, 2)}\n`,
    },
    {
      path: "instructions.md",
      kind: "file",
      mediaType: "text/markdown",
      encoding: "utf-8",
      content: `${version.instructions}\n`,
    },
    ...files.map((resource) => ({
      path: resource.path,
      kind: "file" as const,
      mediaType: resource.mediaType,
      encoding: "utf-8" as const,
      content: resource.content,
    })),
  ],
});
