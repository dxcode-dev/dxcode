import { env } from "cloudflare:workers";
import {
  MAX_SKILL_FILE_BYTES,
  ResolvedSkillSnapshots,
  SkillId,
  SkillIntegrity,
  SkillResource,
  SkillResourcePath,
  SkillVersion,
  type Thread,
  ThreadId,
} from "@dx/domain";
import { Effect, Result, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { readSkillFileContent } from "./file-store.js";

export class SkillResourceForbidden extends Schema.TaggedError<SkillResourceForbidden>()(
  "SkillResourceForbidden",
  {},
) {}

export class SkillExecutionUnavailable extends Schema.TaggedError<SkillExecutionUnavailable>()(
  "SkillExecutionUnavailable",
  {},
) {}

const VersionRow = Schema.Struct({
  skill_id: Schema.String,
  version: Schema.Finite,
  description: Schema.String,
  instructions: Schema.String,
  manifest_json: Schema.String,
  mcp_server_ids_json: Schema.String,
  integrity: Schema.String,
});

const ResourceRow = Schema.Struct({
  path: Schema.String,
  media_type: Schema.String,
  /** NULL while the content is in R2 (file-store.ts). */
  content: Schema.NullOr(Schema.String),
  size_bytes: Schema.Finite,
  integrity: Schema.String,
});

const ResourceMetadataRow = Schema.Struct({
  path: Schema.String,
  media_type: Schema.String,
  size_bytes: Schema.Finite,
  integrity: Schema.String,
});

const ResourceMetadata = Schema.Struct({
  path: SkillResourcePath,
  mediaType: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_SKILL_FILE_BYTES }),
  ),
  integrity: SkillIntegrity,
});

const ThreadSnapshotRow = Schema.Struct({ skill_snapshot_json: Schema.String });

const parseJson = <A>(
  value: string,
): Effect.Effect<A, SkillExecutionUnavailable> =>
  Effect.try({
    try: () => JSON.parse(value) as A,
    catch: () => new SkillExecutionUnavailable(),
  });

const decodeResource = (resource: typeof ResourceRow.Type, content: string) =>
  Schema.decodeUnknownEffect(SkillResource)({
    path: resource.path,
    mediaType: resource.media_type,
    content,
    sizeBytes: resource.size_bytes,
    integrity: resource.integrity,
  }).pipe(Effect.mapError(() => new SkillExecutionUnavailable()));

const decodeResourceMetadata = (resource: typeof ResourceMetadataRow.Type) =>
  Schema.decodeUnknownEffect(ResourceMetadata)({
    path: resource.path,
    mediaType: resource.media_type,
    sizeBytes: resource.size_bytes,
    integrity: resource.integrity,
  }).pipe(Effect.mapError(() => new SkillExecutionUnavailable()));

export const resolveSkillAgentData = Effect.fn("resolveSkillAgentData")(
  function* (binding: unknown, thread: Thread) {
    const db = yield* decodeD1Binding(binding).pipe(
      Effect.mapError(() => new SkillExecutionUnavailable()),
    );
    return yield* Effect.all(
      thread.skills.map((snapshot) =>
        Effect.gen(function* () {
          const versionRow = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT skill_id, version, description, instructions,
                          manifest_json, mcp_server_ids_json, integrity
                     FROM skill_version
                    WHERE skill_id = ? AND version = ? LIMIT 1`,
                )
                .bind(snapshot.id, snapshot.version)
                .first(),
            catch: () => new SkillExecutionUnavailable(),
          });
          if (versionRow === null)
            return yield* new SkillExecutionUnavailable();
          const version = yield* Schema.decodeUnknownEffect(VersionRow)(
            versionRow,
          ).pipe(Effect.mapError(() => new SkillExecutionUnavailable()));
          if (
            version.integrity !== snapshot.integrity ||
            version.skill_id !== snapshot.id ||
            version.version !== snapshot.version
          ) {
            return yield* new SkillExecutionUnavailable();
          }
          const manifest = yield* parseJson<{
            readonly description?: unknown;
          }>(version.manifest_json);
          const resourcesResult = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT path, media_type, size_bytes, integrity
                     FROM skill_resource
                    WHERE skill_id = ? AND version = ? ORDER BY path`,
                )
                .bind(snapshot.id, snapshot.version)
                .all(),
            catch: () => new SkillExecutionUnavailable(),
          });
          const resourceRows = yield* Schema.decodeUnknownEffect(
            Schema.Array(ResourceMetadataRow),
          )(resourcesResult.results).pipe(
            Effect.mapError(() => new SkillExecutionUnavailable()),
          );
          const resources = yield* Effect.all(
            resourceRows.map(decodeResourceMetadata),
          );
          return {
            id: snapshot.id,
            version: snapshot.version,
            name: snapshot.name,
            scope: snapshot.scope,
            integrity: snapshot.integrity,
            description:
              typeof manifest.description === "string"
                ? manifest.description
                : version.description,
            resources,
          };
        }),
      ),
      { concurrency: 4 },
    );
  },
);

/**
 * A skill version for a Thread whose snapshot holds that version: its
 * SKILL.md body and description, and its files, each checked against its
 * integrity (every file, or those at `paths`). One snapshot read, one
 * version read, and one file query however many files; content R2 holds is
 * read from there.
 */
export const readSkillResources = Effect.fn("readSkillResources")(function* (
  bindings: Bindings,
  rawThreadId: string,
  rawSkillId: string,
  rawVersion: number,
  rawPaths?: ReadonlyArray<string>,
) {
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(() => new SkillExecutionUnavailable()),
  );
  const threadId = yield* Schema.decodeEffect(ThreadId)(rawThreadId).pipe(
    Effect.mapError(() => new SkillResourceForbidden()),
  );
  const skillId = yield* Schema.decodeEffect(SkillId)(rawSkillId).pipe(
    Effect.mapError(() => new SkillResourceForbidden()),
  );
  const version = yield* Schema.decodeEffect(SkillVersion)(rawVersion).pipe(
    Effect.mapError(() => new SkillResourceForbidden()),
  );
  const paths =
    rawPaths === undefined
      ? undefined
      : yield* Effect.forEach(rawPaths, (path) =>
          Schema.decodeEffect(SkillResourcePath)(path).pipe(
            Effect.mapError(() => new SkillResourceForbidden()),
          ),
        );
  const [threadRows, versionRows, resourceRows] = yield* Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .prepare(
            "SELECT skill_snapshot_json FROM threads WHERE id = ? LIMIT 1",
          )
          .bind(threadId),
        db
          .prepare(
            "SELECT integrity, instructions, description FROM skill_version WHERE skill_id = ? AND version = ? LIMIT 1",
          )
          .bind(skillId, version),
        db
          .prepare(
            `SELECT path, media_type, content, size_bytes, integrity
               FROM skill_resource
              WHERE skill_id = ? AND version = ?
                ${paths === undefined ? "" : "AND path IN (SELECT value FROM json_each(?))"}
              ORDER BY path`,
          )
          .bind(
            skillId,
            version,
            ...(paths === undefined ? [] : [JSON.stringify(paths)]),
          ),
      ]),
    catch: () => new SkillExecutionUnavailable(),
  });
  const threadRow = threadRows?.results[0];
  if (threadRow === undefined) return yield* new SkillResourceForbidden();
  const decodedThread = yield* Schema.decodeUnknownEffect(ThreadSnapshotRow)(
    threadRow,
  ).pipe(Effect.mapError(() => new SkillExecutionUnavailable()));
  const rawSnapshots = yield* parseJson<unknown>(
    decodedThread.skill_snapshot_json,
  );
  const snapshots = yield* Schema.decodeUnknownEffect(ResolvedSkillSnapshots)(
    rawSnapshots,
  ).pipe(Effect.mapError(() => new SkillExecutionUnavailable()));
  const authorized = snapshots.find(
    (snapshot) => snapshot.id === skillId && snapshot.version === version,
  );
  if (authorized === undefined) return yield* new SkillResourceForbidden();
  const versionRow = versionRows?.results[0] as
    | {
        readonly integrity?: unknown;
        readonly instructions?: unknown;
        readonly description?: unknown;
      }
    | undefined;
  if (versionRow?.integrity !== authorized.integrity) {
    return yield* new SkillExecutionUnavailable();
  }
  const instructions = String(versionRow.instructions ?? "");
  const description = String(versionRow.description ?? "");
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ResourceRow))(
    resourceRows?.results ?? [],
  ).pipe(Effect.mapError(() => new SkillExecutionUnavailable()));
  const files = yield* Effect.forEach(
    rows,
    (row) =>
      Effect.gen(function* () {
        const content = yield* Effect.tryPromise({
          try: () => readSkillFileContent(bindings.DX_STORAGE, row),
          catch: () => new SkillExecutionUnavailable(),
        });
        if (content === undefined) {
          return yield* new SkillExecutionUnavailable();
        }
        const resource = yield* decodeResource(row, content);
        const digest = yield* Effect.promise(() => sha256Hex(content)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SkillIntegrity)),
          Effect.mapError(() => new SkillExecutionUnavailable()),
        );
        if (digest !== resource.integrity) {
          return yield* new SkillExecutionUnavailable();
        }
        return {
          skillId,
          version,
          path: resource.path,
          mediaType: resource.mediaType,
          content: resource.content,
          sizeBytes: resource.sizeBytes,
          integrity: resource.integrity,
        };
      }),
    { concurrency: 8 },
  );
  return { instructions, description, files };
});

const sha256Hex = async (content: string) => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** One file of a skill version in the Thread's snapshot. */
export const readSkillResource = Effect.fn("readSkillResource")(function* (
  bindings: Bindings,
  rawThreadId: string,
  rawSkillId: string,
  rawVersion: number,
  rawPath: string,
) {
  const {
    files: [resource],
  } = yield* readSkillResources(bindings, rawThreadId, rawSkillId, rawVersion, [
    rawPath,
  ]);
  if (resource === undefined) return yield* new SkillResourceForbidden();
  return resource;
});

/**
 * A skill version in the Thread's snapshot: its SKILL.md body and every
 * file by path, or undefined when the read is refused or fails.
 */
export const readThreadSkillResources = async (
  threadId: string,
  skillId: string,
  version: number,
): Promise<
  | {
      readonly instructions: string;
      readonly files: ReadonlyMap<string, string>;
    }
  | undefined
> => {
  const result = await Effect.runPromise(
    Effect.result(
      readSkillResources(env as Bindings, threadId, skillId, version),
    ),
  );
  return Result.isSuccess(result)
    ? {
        instructions: result.success.instructions,
        files: new Map(
          result.success.files.map(({ path, content }) => [path, content]),
        ),
      }
    : undefined;
};
