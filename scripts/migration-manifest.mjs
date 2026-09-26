import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
export const migrationManifestPath = resolve(
  workspaceRoot,
  "apps/core/migration-manifest.json",
);

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const hasUniqueValues = (values) => new Set(values).size === values.length;

export const sourceControlSchemaVersion = (manifest) => {
  const filename = manifest.d1.at(-1)?.filename;
  const match = /^(\d{4})_/.exec(filename ?? "");
  if (match === null)
    throw new Error("The canonical migration manifest has no schema version.");
  return match[1];
};

export const resolveD1MigrationsDirectory = (configPath, migrationsDirectory) =>
  resolve(dirname(configPath), migrationsDirectory);

/**
 * Destructive D1 migrations require an exact, manifest-reviewed acceptance.
 * Durable Object migrations remain non-destructive only.
 */
export const assertAcceptedDestructiveMigrations = (manifest) => {
  const accepted = manifest.acceptedDestructiveD1Migrations;
  if (
    !Array.isArray(accepted) ||
    !accepted.every((filename) => typeof filename === "string") ||
    !hasUniqueValues(accepted)
  ) {
    throw new Error(
      "The canonical migration manifest has an invalid destructive D1 migration acceptance list.",
    );
  }

  const d1ByFilename = new Map(
    manifest.d1.map((entry) => [entry.filename, entry]),
  );
  for (const filename of accepted) {
    const entry = d1ByFilename.get(filename);
    if (entry?.classification !== "destructive") {
      throw new Error(
        `Accepted destructive D1 migration is missing or not destructive: ${filename}`,
      );
    }
  }

  const unaccepted = manifest.d1
    .filter(
      (entry) =>
        entry.classification === "destructive" &&
        !accepted.includes(entry.filename),
    )
    .map((entry) => entry.filename);
  if (unaccepted.length > 0) {
    throw new Error(
      `Ordinary migration paths reject unaccepted destructive entries before writes: ${unaccepted.join(", ")}`,
    );
  }

  const destructiveDurableObjects = manifest.durableObjects
    .filter((entry) => entry.classification === "destructive")
    .map((entry) => entry.tag);
  if (destructiveDurableObjects.length > 0) {
    throw new Error(
      `Ordinary migration paths reject destructive Durable Object entries before writes: ${destructiveDurableObjects.join(", ")}`,
    );
  }
};

export const loadMigrationManifest = async () => {
  const manifest = JSON.parse(await readFile(migrationManifestPath, "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.d1Directory !== "migrations" ||
    !Array.isArray(manifest.d1) ||
    !Array.isArray(manifest.durableObjects) ||
    !manifest.d1.some(
      ({ filename }) => filename === manifest.previousAcceptedD1Migration,
    )
  ) {
    throw new Error("The canonical migration manifest has an invalid shape.");
  }
  const d1MigrationsDirectory = resolve(
    workspaceRoot,
    "apps/core",
    manifest.d1Directory,
  );

  const filenames = manifest.d1.map(({ filename }) => filename);
  const tags = manifest.durableObjects.map(({ tag }) => tag);
  if (!hasUniqueValues(filenames) || !hasUniqueValues(tags)) {
    throw new Error(
      "Migration filenames and Durable Object tags must be unique.",
    );
  }

  const directoryFilenames = (await readdir(d1MigrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  if (JSON.stringify(filenames) !== JSON.stringify(directoryFilenames)) {
    throw new Error(
      "The ordered D1 migration manifest does not exactly match the migration directory.",
    );
  }

  const d1 = await Promise.all(
    manifest.d1.map(async (entry) => {
      if (
        !new Set(["non-destructive", "destructive"]).has(entry.classification)
      ) {
        throw new Error(
          `D1 migration ${entry.filename} has no valid classification.`,
        );
      }
      const sql = await readFile(
        resolve(d1MigrationsDirectory, entry.filename),
        "utf8",
      );
      if (sha256(sql) !== entry.sha256) {
        throw new Error(`D1 migration hash drifted: ${entry.filename}`);
      }
      return { ...entry, sql };
    }),
  );

  for (const entry of manifest.durableObjects) {
    if (
      !new Set(["non-destructive", "destructive"]).has(entry.classification)
    ) {
      throw new Error(
        `Durable Object migration ${entry.tag} has no valid classification.`,
      );
    }
    const content = JSON.stringify({
      tag: entry.tag,
      newSqliteClasses: entry.newSqliteClasses,
    });
    if (sha256(content) !== entry.sha256) {
      throw new Error(`Durable Object migration hash drifted: ${entry.tag}`);
    }
  }

  const loaded = { ...manifest, d1 };
  assertAcceptedDestructiveMigrations(loaded);
  return loaded;
};
