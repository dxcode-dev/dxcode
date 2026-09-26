import {
  MAX_SKILL_FILE_BYTES,
  ResolvedSkillSnapshots,
  SkillId,
  SkillIntegrity,
  SkillResource,
  SkillResourcePath,
  SkillVersion,
  ThreadId,
  type Thread,
} from "@dx/domain";
import { defineTool } from "@flue/runtime";
import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import * as v from "valibot";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";

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
  content: Schema.String,
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

const decodeResource = (resource: typeof ResourceRow.Type) =>
  Schema.decodeUnknownEffect(SkillResource)({
    path: resource.path,
    mediaType: resource.media_type,
    content: resource.content,
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
            instructions: version.instructions,
            resources,
          };
        }),
      ),
      { concurrency: 4 },
    );
  },
);

export const readSkillResource = Effect.fn("readSkillResource")(function* (
  bindings: Bindings,
  rawThreadId: string,
  rawSkillId: string,
  rawVersion: number,
  rawPath: string,
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
  const path = yield* Schema.decodeEffect(SkillResourcePath)(rawPath).pipe(
    Effect.mapError(() => new SkillResourceForbidden()),
  );
  const threadRow = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare("SELECT skill_snapshot_json FROM threads WHERE id = ? LIMIT 1")
        .bind(threadId)
        .first(),
    catch: () => new SkillExecutionUnavailable(),
  });
  if (threadRow === null) return yield* new SkillResourceForbidden();
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
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT path, media_type, content, size_bytes, integrity
             FROM skill_resource
            WHERE skill_id = ? AND version = ? AND path = ? LIMIT 1`,
        )
        .bind(skillId, version, path)
        .first(),
    catch: () => new SkillExecutionUnavailable(),
  });
  if (row === null) return yield* new SkillResourceForbidden();
  const resourceRow = yield* Schema.decodeUnknownEffect(ResourceRow)(row).pipe(
    Effect.mapError(() => new SkillExecutionUnavailable()),
  );
  const resource = yield* decodeResource(resourceRow);
  const versionRow = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          "SELECT integrity FROM skill_version WHERE skill_id = ? AND version = ? LIMIT 1",
        )
        .bind(skillId, version)
        .first<{ integrity: string }>(),
    catch: () => new SkillExecutionUnavailable(),
  });
  if (versionRow?.integrity !== authorized.integrity) {
    return yield* new SkillExecutionUnavailable();
  }
  const digest = yield* Effect.promise(async () => {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(resource.content),
    );
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }).pipe(
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
});

export const createSkillResourceTool = (threadId: string) =>
  defineTool({
    name: "read_dx_skill_resource",
    description:
      "Read one reviewed text resource from an immutable skill version resolved for this Thread. Use only the skill ID, version, and resource path listed in the system instructions.",
    input: v.object({
      skillId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      version: v.pipe(v.number(), v.integer(), v.minValue(1)),
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    }),
    async run({ data }) {
      const output = await Effect.runPromise(
        readSkillResource(
          env as Bindings,
          threadId,
          data.skillId,
          data.version,
          data.path,
        ),
      );
      return { output };
    },
  });
