import {
  MAX_SKILL_FILE_BYTES,
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

const textEncoder = new TextEncoder();

const mediaTypes = new Map([
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".toml", "application/toml"],
]);

const acceptedBrowserMediaTypes = new Set([
  "",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "application/csv",
  "application/yaml",
  "text/yaml",
  "application/x-yaml",
  "application/toml",
]);

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

const mediaTypeFor = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : mediaTypes.get(path.slice(dot).toLowerCase());
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
          reason: "Use a bounded browser-file bundle with UTF-8 text files.",
        }),
    ),
  );
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of bundle.files) {
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
    if (file.kind !== "file") {
      return yield* reject(file.path, "Symlinks are not allowed.");
    }
    if (!acceptedBrowserMediaTypes.has(file.mediaType.toLowerCase())) {
      return yield* reject(
        file.path,
        "Binary and unsafe media types are not allowed.",
      );
    }
    const bytes = yield* checkedText(
      file.content,
      file.path,
      MAX_SKILL_FILE_BYTES,
    );
    totalBytes += bytes;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      return yield* reject(
        "files",
        `Bundle exceeds the ${MAX_SKILL_TOTAL_BYTES.toLocaleString()} byte limit.`,
      );
    }
  }

  const manifestFile = bundle.files.find(({ path }) => path === "skill.json");
  const instructionsFile = bundle.files.find(
    ({ path }) => path === "instructions.md",
  );
  if (manifestFile === undefined) {
    return yield* reject("skill.json", "The declarative manifest is required.");
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
  const instructions = yield* Schema.decodeUnknownEffect(SkillInstructions)(
    instructionsFile.content.trim(),
  ).pipe(
    Effect.mapError(
      () =>
        new SkillImportRejected({
          field: "instructions.md",
          reason: "Instructions must contain 1–32,768 characters.",
        }),
    ),
  );
  const resourceFiles = bundle.files.filter(
    ({ path }) => path !== "skill.json" && path !== "instructions.md",
  );
  if (resourceFiles.length > MAX_SKILL_RESOURCE_FILES) {
    return yield* reject(
      "resources",
      `Use at most ${MAX_SKILL_RESOURCE_FILES} resource files.`,
    );
  }
  const resources = yield* Effect.all(
    resourceFiles.map((file) =>
      Effect.gen(function* () {
        if (!file.path.startsWith("resources/")) {
          return yield* reject(
            file.path,
            "Supporting files must be inside resources/.",
          );
        }
        const mediaType = mediaTypeFor(file.path);
        if (mediaType === undefined) {
          return yield* reject(
            file.path,
            "Only Markdown, text, JSON, CSV, YAML, and TOML resources are allowed.",
          );
        }
        const path = Schema.decodeOption(SkillResourcePath)(file.path);
        if (Option.isNone(path)) {
          return yield* reject(file.path, "Resource path is too long.");
        }
        const sizeBytes = textEncoder.encode(file.content).byteLength;
        const integrity = yield* Effect.promise(() =>
          sha256(file.content),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SkillIntegrity)));
        return yield* Schema.decodeUnknownEffect(SkillResource)({
          path: path.value,
          mediaType,
          content: file.content,
          sizeBytes,
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
    source: bundle.source,
    integrity,
    totalBytes,
  } satisfies SkillPreview;
});

export const exportSkillVersion = (
  version: StoredSkillVersion,
): SkillImportBundle => ({
  source: version.source,
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
    ...version.resources.map((resource) => ({
      path: resource.path,
      kind: "file" as const,
      mediaType: resource.mediaType,
      encoding: "utf-8" as const,
      content: resource.content,
    })),
  ],
});
