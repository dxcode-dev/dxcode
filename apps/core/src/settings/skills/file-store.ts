/**
 * Where a skill file's content lives. A file up to INLINE_SKILL_FILE_BYTES
 * stays in its D1 row; a larger one goes to R2 at skill-files/<integrity>,
 * so identical files share one immutable object, and its row's content is
 * NULL. Without an R2 binding (some tests) every file stays in D1.
 */

export const INLINE_SKILL_FILE_BYTES = 16_384;

export const skillFileKey = (integrity: string) => `skill-files/${integrity}`;

export const storesInR2 = (
  bucket: R2Bucket | undefined,
  sizeBytes: number,
): bucket is R2Bucket =>
  bucket !== undefined && sizeBytes > INLINE_SKILL_FILE_BYTES;

/**
 * Writes the R2 objects of files too large for D1 before their rows, so a
 * row never names a missing object. An object already there is the same
 * content, by its key.
 */
export const putSkillFiles = async (
  bucket: R2Bucket | undefined,
  files: ReadonlyArray<{
    readonly mediaType: string;
    readonly content: string;
    readonly sizeBytes: number;
    readonly integrity: string;
  }>,
) => {
  const large = files.filter(({ sizeBytes }) => storesInR2(bucket, sizeBytes));
  if (bucket === undefined || large.length === 0) return;
  const unique = [
    ...new Map(large.map((file) => [file.integrity, file])).values(),
  ];
  for (let index = 0; index < unique.length; index += 8) {
    await Promise.all(
      unique.slice(index, index + 8).map(async (file) => {
        const key = skillFileKey(file.integrity);
        if ((await bucket.head(key)) !== null) return;
        await bucket.put(key, file.content, {
          httpMetadata: { contentType: `${file.mediaType}; charset=utf-8` },
          sha256: file.integrity,
        });
      }),
    );
  }
};

/**
 * A file's content: its row's, or its R2 object's when the row holds none.
 * Undefined when the object is missing or the bucket is unavailable.
 */
export const readSkillFileContent = async (
  bucket: R2Bucket | undefined,
  row: { readonly content: string | null; readonly integrity: string },
): Promise<string | undefined> => {
  if (row.content !== null) return row.content;
  const object = await bucket?.get(skillFileKey(row.integrity));
  return object === null || object === undefined ? undefined : object.text();
};
