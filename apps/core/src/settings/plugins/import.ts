import {
  MAX_PLUGIN_FILE_BYTES,
  MAX_PLUGIN_MANIFEST_BYTES,
  MAX_PLUGIN_TOTAL_BYTES,
  PluginFile,
  PluginImportBundle,
  PluginIntegrity,
  PluginManifest,
  type PluginSource,
  type StoredPluginVersion,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";

const textEncoder = new TextEncoder();

const acceptedMediaTypes = new Set([
  "",
  "application/javascript",
  "application/json",
  "application/node",
  "text/javascript",
  "text/plain",
]);

const sourceExtensions = new Set([".js", ".mjs", ".json", ".txt"]);

export class PluginImportRejected extends Schema.TaggedError<PluginImportRejected>()(
  "PluginImportRejected",
  { field: Schema.String, reason: Schema.String },
) {}

export interface PluginPreview {
  readonly manifest: typeof PluginManifest.Type;
  readonly files: ReadonlyArray<typeof PluginFile.Type>;
  readonly source: PluginSource;
  readonly integrity: typeof PluginIntegrity.Type;
  readonly totalBytes: number;
}

const reject = (field: string, reason: string) =>
  Effect.fail(new PluginImportRejected({ field, reason }));

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

const extensionFor = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
};

const sameMembers = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
) =>
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

const validateDeclarations = Effect.fn("validatePluginDeclarations")(function* (
  manifest: typeof PluginManifest.Type,
) {
  if (!manifest.entrypoint.endsWith(".mjs") || !safePath(manifest.entrypoint)) {
    return yield* reject(
      "plugin.json.entrypoint",
      "Entrypoint must be a safe relative .mjs path.",
    );
  }
  if (
    !sameMembers(
      manifest.tools.map(({ name }) => name),
      manifest.permissions.tools,
    ) ||
    !sameMembers(
      manifest.commands.map(({ name }) => name),
      manifest.permissions.commands,
    ) ||
    !sameMembers(
      manifest.lifecycle.map(({ event }) => event),
      manifest.permissions.lifecycle,
    ) ||
    !sameMembers(
      manifest.triggers.map(({ name }) => name),
      manifest.permissions.triggers,
    ) ||
    !sameMembers(
      manifest.uiSurfaces.map(({ id }) => id),
      manifest.permissions.uiSurfaces,
    )
  ) {
    return yield* reject(
      "plugin.json.permissions",
      "Every declared tool, command, lifecycle hook, trigger, and UI surface must be requested exactly once.",
    );
  }
  const toolNames = new Set(manifest.tools.map(({ name }) => name));
  if (manifest.commands.some(({ tool }) => !toolNames.has(tool))) {
    return yield* reject(
      "plugin.json.commands",
      "Every command must reference a declared tool.",
    );
  }
});

const canonicalPayload = (preview: {
  readonly manifest: typeof PluginManifest.Type;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly mediaType: string;
    readonly content: string;
  }>;
}) =>
  JSON.stringify({
    manifest: preview.manifest,
    files: [...preview.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, mediaType, content }) => ({ path, mediaType, content })),
  });

export const previewPluginImport = Effect.fn("previewPluginImport")(function* (
  unknownBundle: unknown,
) {
  const bundle = yield* Schema.decodeUnknownEffect(PluginImportBundle)(
    unknownBundle,
    { onExcessProperty: "error" },
  ).pipe(
    Effect.mapError(
      () =>
        new PluginImportRejected({
          field: "files",
          reason: "Use a bounded reviewed UTF-8 browser-file bundle.",
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
    if (!acceptedMediaTypes.has(file.mediaType.toLowerCase())) {
      return yield* reject(
        file.path,
        "Binary and remote-rendered files are not allowed.",
      );
    }
    if (!sourceExtensions.has(extensionFor(file.path))) {
      return yield* reject(
        file.path,
        "Only JavaScript modules, JSON, and plain text source files are allowed.",
      );
    }
    const bytes = yield* checkedText(
      file.content,
      file.path,
      MAX_PLUGIN_FILE_BYTES,
    );
    totalBytes += bytes;
    if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
      return yield* reject(
        "files",
        `Bundle exceeds the ${MAX_PLUGIN_TOTAL_BYTES.toLocaleString()} byte limit.`,
      );
    }
  }

  const manifestFile = bundle.files.find(({ path }) => path === "plugin.json");
  if (manifestFile === undefined) {
    return yield* reject(
      "plugin.json",
      "The declarative manifest is required.",
    );
  }
  yield* checkedText(
    manifestFile.content,
    "plugin.json",
    MAX_PLUGIN_MANIFEST_BYTES,
  );
  const rawManifest = yield* Effect.try({
    try: () => JSON.parse(manifestFile.content) as unknown,
    catch: () =>
      new PluginImportRejected({
        field: "plugin.json",
        reason: "Manifest must be valid JSON.",
      }),
  });
  const manifest = yield* Schema.decodeUnknownEffect(PluginManifest)(
    rawManifest,
    { onExcessProperty: "error" },
  ).pipe(
    Effect.mapError(
      () =>
        new PluginImportRejected({
          field: "plugin.json",
          reason:
            "Manifest must use schemaVersion 1 and only supported declarations and permissions.",
        }),
    ),
  );
  yield* validateDeclarations(manifest);
  if (!paths.has(manifest.entrypoint)) {
    return yield* reject(
      "plugin.json.entrypoint",
      "Entrypoint must be included in the reviewed bundle.",
    );
  }

  const files = yield* Effect.all(
    bundle.files.map((file) =>
      Effect.gen(function* () {
        const sizeBytes = textEncoder.encode(file.content).byteLength;
        const integrity = yield* Effect.promise(() =>
          sha256(file.content),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PluginIntegrity)));
        const path = Schema.decodeOption(PluginFile.fields.path)(file.path);
        if (Option.isNone(path)) {
          return yield* reject(file.path, "Source path is too long.");
        }
        return yield* Schema.decodeUnknownEffect(PluginFile)({
          path: path.value,
          mediaType:
            file.mediaType === ""
              ? file.path.endsWith(".json")
                ? "application/json"
                : "text/javascript"
              : file.mediaType,
          content: file.content,
          sizeBytes,
          integrity,
        });
      }),
    ),
  );
  const integrity = yield* Effect.promise(() =>
    sha256(canonicalPayload({ manifest, files })),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PluginIntegrity)));

  return {
    manifest,
    files,
    source: bundle.source,
    integrity,
    totalBytes,
  } satisfies PluginPreview;
});

export const exportPluginVersion = (
  version: StoredPluginVersion,
): typeof PluginImportBundle.Type => ({
  source: version.source,
  files: version.files.map((file) => ({
    path: file.path,
    kind: "file" as const,
    mediaType: file.mediaType,
    encoding: "utf-8" as const,
    content: file.content,
  })),
});
