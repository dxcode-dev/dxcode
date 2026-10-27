import { PersistenceUnavailable } from "@dx/domain";
import { Effect, Schema } from "effect";

export class InvalidAvatarUpload extends Schema.TaggedError<InvalidAvatarUpload>()(
  "InvalidAvatarUpload",
  {},
) {}

export const MAX_AVATAR_BYTES = 512 * 1024;

const extensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

/** The URL that serves the picture stored at `key`, when there is one. */
export const avatarUrl = (key: string | undefined) =>
  key === undefined ? undefined : `/v1/${key}`;

/**
 * SQL for the picture dx shows for a person: their upload, else the image
 * their identity provider gave.
 */
export const userImageSql = (user: string, account: string) =>
  `CASE WHEN ${account}.avatar_key IS NULL THEN ${user}.image
        ELSE '/v1/' || ${account}.avatar_key END`;

/**
 * The image in a request body: PNG, JPEG, or WebP, at most 512 KB. SVG is
 * refused because it can carry script.
 */
export const readAvatarUpload = Effect.fn("readAvatarUpload")(function* (
  request: Request,
) {
  const contentType = request.headers.get("content-type") ?? "";
  const extension = extensions.get(contentType);
  if (extension === undefined) return yield* new InvalidAvatarUpload();
  const bytes = yield* Effect.tryPromise({
    try: async () => {
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES)
        throw new Error("Request body exceeds the size limit.");
      const reader = request.body?.getReader();
      if (reader === undefined) return new Uint8Array();
      const chunks: Array<Uint8Array> = [];
      let length = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > MAX_AVATAR_BYTES) {
          await reader.cancel();
          throw new Error("Request body exceeds the size limit.");
        }
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
    catch: () => new InvalidAvatarUpload(),
  });
  if (bytes.byteLength === 0) return yield* new InvalidAvatarUpload();
  return { bytes, contentType, extension };
});

const storageFor = (storage: R2Bucket | undefined, operation: string) =>
  storage === undefined
    ? Effect.fail(
        PersistenceUnavailable.new(
          { operation },
          new Error("DX_STORAGE binding is unavailable."),
        ),
      )
    : Effect.succeed(storage);

/**
 * Stores a new picture under `prefix`, points the owner at it with
 * `assign`, then deletes the picture it replaced. Removes the new object
 * when `assign` fails. `assign` returns the key it replaced.
 */
export const replaceAvatar = <E, R>(
  storage: R2Bucket | undefined,
  prefix: string,
  upload: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly extension: string;
  },
  assign: (key: string) => Effect.Effect<string | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const bucket = yield* storageFor(storage, "avatar.put");
    const key = `${prefix}/${crypto.randomUUID()}.${upload.extension}`;
    yield* Effect.tryPromise({
      try: () =>
        bucket.put(key, upload.bytes, {
          httpMetadata: { contentType: upload.contentType },
        }),
      catch: (cause) =>
        PersistenceUnavailable.new({ operation: "avatar.put" }, cause),
    });
    const previous = yield* assign(key).pipe(
      Effect.onError(() => deleteQuietly(bucket, key)),
    );
    if (previous !== undefined) yield* deleteQuietly(bucket, previous);
  });

/** Clears the owner's picture with `clear` and deletes the object it had. */
export const removeAvatar = <E, R>(
  storage: R2Bucket | undefined,
  clear: Effect.Effect<string | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const bucket = yield* storageFor(storage, "avatar.delete");
    const previous = yield* clear;
    if (previous !== undefined) yield* deleteQuietly(bucket, previous);
  });

const deleteQuietly = (bucket: R2Bucket, key: string) =>
  Effect.tryPromise({
    try: () => bucket.delete(key),
    catch: () => undefined,
  }).pipe(Effect.ignore);

/**
 * Points a row's `avatar_key` at `key` (or clears it) and returns the key it
 * had. One D1 batch, so no other write lands between the read and the update.
 */
export const swapAvatarKey = (
  db: D1Database,
  table: "personal_account" | "organization",
  idColumn: "user_id" | "id",
  id: string,
  key: string | null,
) =>
  Effect.tryPromise({
    try: async () => {
      const [previous, updated] = await db.batch<{ avatar_key: string | null }>(
        [
          db
            .prepare(`SELECT avatar_key FROM ${table} WHERE ${idColumn} = ?`)
            .bind(id),
          db
            .prepare(
              `UPDATE ${table} SET avatar_key = ? WHERE ${idColumn} = ? RETURNING avatar_key`,
            )
            .bind(key, id),
        ],
      );
      return {
        found: (updated?.results.length ?? 0) > 0,
        previous: previous?.results[0]?.avatar_key ?? undefined,
      };
    },
    catch: (cause) =>
      PersistenceUnavailable.new(
        { operation: `avatar.assign.${table}` },
        cause,
      ),
  });
