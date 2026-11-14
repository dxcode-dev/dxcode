/** Deletes every R2 object under `prefix`, a page at a time. */
export const deleteBlobPrefix = async (bucket: R2Bucket, prefix: string) => {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const keys = page.objects.map(({ key }) => key);
    if (keys.length > 0) await bucket.delete(keys);
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
};
