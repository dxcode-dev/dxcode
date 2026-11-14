import {
  PluginBundleIcon,
  type PluginIconFileContent,
  PluginIconSet,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { legacyIconFile } from "../../settings/plugins/bundles/plugin-icon.js";

/**
 * Plugin icon files (migration 0187), stored once per sha256 of their bytes.
 * An install writes its files with the version; a file already stored by
 * another install or version is left as it is, since the same hash is the
 * same bytes.
 */

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

/** Statements that store each file not stored yet, for the install's batch. */
export const pluginIconStatements = (
  db: D1Database,
  files: ReadonlyArray<PluginIconFileContent>,
) => {
  const now = new Date().toISOString();
  const seen = new Set<string>();
  return files.flatMap((file) => {
    if (seen.has(file.hash)) return [];
    seen.add(file.hash);
    return [
      db
        .prepare(
          `INSERT OR IGNORE INTO plugin_icon (hash, media_type, data, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(file.hash, file.mediaType, toBase64(file.bytes), now),
    ];
  });
};

export interface StoredPluginIcon {
  readonly mediaType: "image/png" | "image/svg+xml";
  readonly bytes: Uint8Array;
}

export const readPluginIcon = async (
  db: D1Database,
  hash: string,
): Promise<StoredPluginIcon | undefined> => {
  const row = await db
    .prepare("SELECT media_type, data FROM plugin_icon WHERE hash = ?")
    .bind(hash)
    .first<{ media_type: string; data: string }>();
  if (row === null) return undefined;
  return {
    mediaType: row.media_type === "image/png" ? "image/png" : "image/svg+xml",
    bytes: Uint8Array.from(atob(row.data), (character) =>
      character.charCodeAt(0),
    ),
  };
};

const logger = getLogger(["dx", "plugins", "icons"]);

const backfilled = new Set<string>();

/**
 * The icon set a stored manifest names. A version stored before icons were
 * hashed has only its base64 `icon`: its hash is worked out here and the
 * file stored once per isolate, so its tag and UI icons serve by hash too.
 */
export const manifestIconSet = async (
  db: D1Database | undefined,
  manifest: { readonly iconSet?: unknown; readonly icon?: unknown },
): Promise<PluginIconSet | undefined> => {
  const set = Schema.decodeUnknownOption(PluginIconSet)(manifest.iconSet);
  if (Option.isSome(set)) return set.value;
  const legacy = Schema.decodeUnknownOption(PluginBundleIcon)(manifest.icon);
  if (Option.isNone(legacy)) return undefined;
  const file = await legacyIconFile(legacy.value);
  if (db !== undefined && !backfilled.has(file.hash)) {
    backfilled.add(file.hash);
    // Not awaited: the icon is served by hash later, never in this request.
    void db.batch(pluginIconStatements(db, [file])).catch((error: unknown) => {
      backfilled.delete(file.hash);
      logger.warn("A legacy plugin icon could not be stored by hash.", {
        event: "plugin_icon_backfill_failed",
        hash: file.hash,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return { src: file.hash };
};

/** The icon set a manifest stored with hashes, without the legacy backfill. */
export const storedIconSet = (manifest: {
  readonly iconSet?: unknown;
}): PluginIconSet | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(PluginIconSet)(manifest.iconSet),
  );
