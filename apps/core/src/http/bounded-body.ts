// Reads a request body with a size cap enforced while it streams in. A body
// sent chunked has no Content-Length, so `request.text()` or `request.json()`
// would hold all of it before any size check; this stops at the cap instead.
// Kept free of other Core modules so the standalone Portal Worker can use it.

/**
 * The body's bytes, or undefined when its declared length or the bytes read
 * so far exceed `maxBytes`. A request without a body reads as empty.
 */
export const readBoundedBody = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
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
};

/** The body as UTF-8 text, or undefined when it exceeds `maxBytes`. */
export const readBoundedText = async (request: Request, maxBytes: number) => {
  const bytes = await readBoundedBody(request, maxBytes);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};
