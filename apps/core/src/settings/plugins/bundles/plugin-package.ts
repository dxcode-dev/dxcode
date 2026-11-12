import {
  MAX_PLUGIN_PACKAGE_BYTES,
  MAX_PLUGIN_PACKAGE_FILES,
  type PluginBundlePackage,
} from "@dx/domain";
import { Context, Effect, Layer } from "effect";
import { type BundleFolder, reject } from "./bundle-reader.js";
import { PluginBundleRejected } from "./errors.js";
import type { ZipEntry } from "./zip.js";

/**
 * A plugin package: the plugin folder's files, in the form dxd lays out as
 * `PLUGIN_ROOT` in the Orb. dx keeps one only for a bundle with a local MCP
 * server, in R2 at `plugin-packages/<sha256>`.
 *
 * The format is deliberately trivial, so dxd parses it without an archive
 * library: the magic `DXPK1\n`, then for each file in path order a 2-byte
 * path length, the UTF-8 path, one flag byte (1 when executable), a 4-byte
 * size, and the bytes. Numbers are big-endian. Paths are relative and
 * already proven safe by the ZIP reader; dxd checks them again.
 */

export const PLUGIN_PACKAGE_MAGIC = "DXPK1\n";

export const pluginPackageKey = (sha256: string) => `plugin-packages/${sha256}`;

export interface BuiltPluginPackage {
  readonly bytes: Uint8Array;
  readonly summary: PluginBundlePackage;
}

const encoder = new TextEncoder();

/** Whether the ZIP reader can return an entry's bytes. */
export const packageable = (entry: ZipEntry) =>
  !entry.symlink &&
  !entry.encrypted &&
  (entry.method === 0 || entry.method === 8);

/**
 * Reads every regular file of the plugin folder into one package. Sizes
 * come from the archive's headers first, so an oversize package is refused
 * before anything is inflated, and the package is written into one buffer
 * of its final size (the reader refuses an entry whose size lied).
 */
export const buildPluginPackage = Effect.fn("buildPluginPackage")(function* (
  folder: BundleFolder,
) {
  const magic = encoder.encode(PLUGIN_PACKAGE_MAGIC);
  const included: Array<{ path: string; entry: ZipEntry; name: Uint8Array }> =
    [];
  let size = magic.byteLength;
  for (const path of [...folder.paths].sort()) {
    const entry = folder.files.get(path);
    if (entry === undefined) continue;
    if (!packageable(entry)) {
      folder.skip(path, "dx cannot copy this file to the Orb.");
      continue;
    }
    const name = encoder.encode(path);
    if (name.byteLength > 1_024) {
      folder.skip(path, "The path is too long to copy to the Orb.");
      continue;
    }
    included.push({ path, entry, name });
    size += 2 + name.byteLength + 1 + 4 + entry.size;
    if (included.length > MAX_PLUGIN_PACKAGE_FILES) {
      return yield* reject(
        `A plugin with a local MCP server holds at most ${MAX_PLUGIN_PACKAGE_FILES.toLocaleString("en-US")} files.`,
      );
    }
    if (size > MAX_PLUGIN_PACKAGE_BYTES) {
      return yield* reject(
        `A plugin with a local MCP server holds at most ${MAX_PLUGIN_PACKAGE_BYTES.toLocaleString("en-US")} bytes.`,
      );
    }
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(magic, 0);
  let offset = magic.byteLength;
  for (const { path, entry, name } of included) {
    const read = yield* folder.peekBytes(path, entry.size);
    if (!read.ok || read.bytes.byteLength !== entry.size) {
      return yield* reject(`dx could not read ${path} to copy it to the Orb.`);
    }
    view.setUint16(offset, name.byteLength);
    bytes.set(name, offset + 2);
    offset += 2 + name.byteLength;
    view.setUint8(offset, entry.executable ? 1 : 0);
    view.setUint32(offset + 1, entry.size);
    offset += 5;
    bytes.set(read.bytes, offset);
    offset += entry.size;
  }
  const files = included.length;
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", bytes),
  );
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    bytes,
    summary: { sha256, size, files },
  } satisfies BuiltPluginPackage;
});

/** The files of a package, as `buildPluginPackage` wrote them. */
export const readPluginPackage = (bytes: Uint8Array) => {
  const magic = encoder.encode(PLUGIN_PACKAGE_MAGIC);
  if (!magic.every((byte, index) => bytes[index] === byte))
    throw new Error("The plugin package is malformed.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: Array<{
    path: string;
    content: Uint8Array;
    executable: boolean;
  }> = [];
  let offset = magic.byteLength;
  while (offset < bytes.byteLength) {
    if (offset + 2 > bytes.byteLength)
      throw new Error("The plugin package is malformed.");
    const length = view.getUint16(offset);
    const path = decoder.decode(
      bytes.subarray(offset + 2, offset + 2 + length),
    );
    offset += 2 + length;
    if (offset + 5 > bytes.byteLength)
      throw new Error("The plugin package is malformed.");
    const executable = view.getUint8(offset) === 1;
    const size = view.getUint32(offset + 1);
    offset += 5;
    if (offset + size > bytes.byteLength)
      throw new Error("The plugin package is malformed.");
    files.push({
      path,
      content: bytes.subarray(offset, offset + size),
      executable,
    });
    offset += size;
  }
  return files;
};

/** Where plugin packages are kept: R2, content-addressed by digest. */
export class PluginPackageStore extends Context.Service<
  PluginPackageStore,
  {
    readonly put: (
      sha256: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, PluginBundleRejected>;
    /** The package's files; empty when it isn't stored. */
    readonly files: (
      sha256: string,
    ) => Effect.Effect<
      ReturnType<typeof readPluginPackage>,
      PluginBundleRejected
    >;
  }
>()("@dx/core/settings/plugins/PluginPackageStore") {
  static readonly r2 = (bucket: R2Bucket | undefined) =>
    Layer.succeed(
      PluginPackageStore,
      PluginPackageStore.of({
        files: (sha256) =>
          bucket === undefined
            ? Effect.succeed([])
            : Effect.tryPromise({
                try: async () => {
                  const object = await bucket.get(pluginPackageKey(sha256));
                  return object === null
                    ? []
                    : readPluginPackage(
                        new Uint8Array(await object.arrayBuffer()),
                      );
                },
                catch: () =>
                  new PluginBundleRejected({
                    reason: "dx could not read the plugin's files.",
                  }),
              }),
        put: (sha256, bytes) =>
          bucket === undefined
            ? Effect.fail(
                new PluginBundleRejected({
                  reason:
                    "This dx deployment has no file storage, so it cannot install a plugin with a local MCP server.",
                }),
              )
            : Effect.tryPromise({
                try: async () => {
                  const key = pluginPackageKey(sha256);
                  // Content-addressed: an existing object already holds these bytes.
                  if ((await bucket.head(key)) !== null) return;
                  await bucket.put(key, bytes, {
                    sha256,
                    httpMetadata: { contentType: "application/octet-stream" },
                  });
                },
                catch: () =>
                  new PluginBundleRejected({
                    reason: "dx could not store the plugin's files. Try again.",
                  }),
              }),
      }),
    );
}
