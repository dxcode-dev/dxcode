import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertApprovedDurableObjectDeletion } from "./approved-durable-object-deletions.mjs";
import { destructiveStatements } from "./migration-destructive-sql.mjs";

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
 * A destructive Durable Object migration (`deletedClasses`) passes only when
 * the owner approved exactly that tag and those classes
 * (scripts/approved-durable-object-deletions.mjs); no setting widens it.
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

  for (const entry of manifest.durableObjects) {
    const deletes = (entry.deletedClasses ?? []).length > 0;
    if (entry.classification !== "destructive" && !deletes) continue;
    const refuse = (why) => {
      throw new Error(
        `Ordinary migration paths reject destructive Durable Object entries before writes: ${entry.tag} (${why})`,
      );
    };
    if (!deletes) refuse("destructive, but it deletes no class");
    if (entry.classification !== "destructive")
      refuse("it deletes classes, so it must be classified destructive");
    try {
      assertApprovedDurableObjectDeletion(
        "core",
        entry.tag,
        entry.deletedClasses,
      );
    } catch (error) {
      refuse(error.message);
    }
  }
};

/**
 * Migrations that were on main before the gate read SQL, whose SQL it reads
 * as losing data while their manifest files them as non-destructive, each
 * read by hand and pinned to its hash. Being listed does not make one safe:
 * each reason says whether it is a false positive (it keeps every row) or a
 * real loss that shipped before this check, left as filed because changing
 * it would change published public-release classifications. It names the public release's squashed
 * files too, since the public repository runs this gate on its own manifest.
 * The list is closed: classify a new migration the gate flags as destructive
 * and accept it, or change its SQL to keep the data.
 */
export const reviewedNonDestructiveD1Migrations = new Map(
  [
    [
      "0030_source_grants.sql",
      "345f83069e0422f612cdb336157348801b7a4dc4450bc1cf7941844b1a9600bf",
      "False positive: keeps every row; the copy joins projects on project_id, a foreign key every row satisfies.",
    ],
    [
      "0041_anonymous_github_source_admission.sql",
      "5e292dc228fcdad3e1ade8eafb6c7197b9dc1a3ce9046f2379635ea75d951e93",
      "Real loss, before this check: drops project_repository.visibility and thread_source_snapshot.provenance, and recreates source_admission_assertion empty.",
    ],
    [
      "0187_drop_thread_artifact_wake.sql",
      "28679eeb1fa737864faa3c19d34064eaf8f1052dc81bcefef1b2de2ebbb816ec",
      "Real loss, before this check: drops thread_artifact_wake, the per-Thread wake interval nothing reads any more.",
    ],
    [
      "0198_standalone_artifacts.sql",
      "ca9ce06f5f9e4a062ee1160aae7e77b2ba02c0dfdd50db591b1092defea4b6fa",
      "Real loss, before this check: deletes the artifact home Threads, and the asks and open-ask markers on artifacts that became standalone.",
    ],
    [
      "0231_private_cloud_orb_sizes.sql",
      "7b87c385512395881a84f11480ef02f32058f20ebe2aa314a214fa67e0652fb2",
      "False positive: keeps every row; the copy keeps the routes whose size the old CHECK allowed, and the migration seeds every one of those sizes first.",
    ],
    [
      "0046_release_v0.2.107.sql",
      "96697f8de1c2061fc9eee061441bbec16b76740fe301ba4781a719d278cad680",
      "Real loss, before this check: the public squash ending at 0187_drop_thread_artifact_wake.sql, which holds it.",
    ],
    [
      "0050_release_v0.2.120.sql",
      "9020f31519e970122b32f9a857d33005acf98f8cef54f92035a2ddd149dccb7f",
      "Real loss, before this check: the public squash ending at 0199_artifact_library_pins_folders.sql, which holds 0198_standalone_artifacts.sql.",
    ],
  ].map(([filename, sha256, reason]) => [filename, { sha256, reason }]),
);

const reviewedNonDestructive = (entry) => {
  const reviewed = reviewedNonDestructiveD1Migrations.get(entry.filename);
  return reviewed !== undefined && reviewed.sha256 === entry.sha256;
};

// node:sqlite warns that it is experimental each time a process loads it.
const loadSqlite = async () => {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning).includes("SQLite"))
      emitWarning.call(process, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
};

const classifiedMigrationSets = new Set();

/**
 * Applies the D1 migrations in order to an empty SQLite database and rejects
 * any filed as non-destructive whose SQL drops a table or column or deletes
 * rows (see migration-destructive-sql.mjs).
 */
export const assertDestructiveSqlClassified = async (d1) => {
  // The replay takes about a second, and a build loads the manifest several
  // times; a set of files that passed once passes again.
  const key = createHash("sha256")
    .update(
      JSON.stringify(
        d1.map(({ filename, classification, sql }) => [
          filename,
          classification,
          sha256(sql),
        ]),
      ),
    )
    .digest("hex");
  if (classifiedMigrationSets.has(key)) return;
  const { DatabaseSync } = await loadSqlite();
  const database = new DatabaseSync(":memory:");
  const problems = [];
  try {
    for (const entry of d1) {
      const reasons = destructiveStatements(database, entry.sql);
      if (
        reasons.length > 0 &&
        entry.classification !== "destructive" &&
        !reviewedNonDestructive(entry)
      ) {
        problems.push(
          `${entry.filename} is classified non-destructive, but its SQL loses data:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`,
        );
      }
    }
  } finally {
    database.close();
  }
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\nClassify each as destructive in apps/core/migration-manifest.json and add it to acceptedDestructiveD1Migrations, or keep the data.`,
    );
  }
  classifiedMigrationSets.add(key);
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
    const content = JSON.stringify(
      entry.deletedClasses === undefined
        ? { tag: entry.tag, newSqliteClasses: entry.newSqliteClasses }
        : { tag: entry.tag, deletedClasses: entry.deletedClasses },
    );
    if (sha256(content) !== entry.sha256) {
      throw new Error(`Durable Object migration hash drifted: ${entry.tag}`);
    }
  }

  const loaded = { ...manifest, d1 };
  assertAcceptedDestructiveMigrations(loaded);
  await assertDestructiveSqlClassified(d1);
  return loaded;
};

/** A manifest Durable Object entry as Wrangler's `migrations` names it. */
export const wranglerDurableObjectMigration = ({
  tag,
  newSqliteClasses,
  deletedClasses,
}) => ({
  tag,
  ...(newSqliteClasses === undefined
    ? {}
    : { new_sqlite_classes: newSqliteClasses }),
  ...(deletedClasses === undefined ? {} : { deleted_classes: deletedClasses }),
});

/** The Durable Object classes Core still exports: created and not deleted. */
export const liveDurableObjectClasses = (durableObjects) => {
  const deleted = new Set(
    durableObjects.flatMap(({ deletedClasses }) => deletedClasses ?? []),
  );
  return durableObjects
    .flatMap(({ newSqliteClasses }) => newSqliteClasses ?? [])
    .filter((className) => !deleted.has(className));
};
