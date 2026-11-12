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
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
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

/**
 * The default cap for a JSON API request body. It sits well above the JSON
 * bodies these routes take (the largest, a message edit, carries up to 1.2
 * million characters), so it only refuses bodies no route would take. A
 * route that takes more, such as Thread creation with inline images, passes
 * its own cap.
 */
export const MAX_JSON_REQUEST_BYTES = 8 * 1024 * 1024;

/** Thrown when a body exceeds its cap; callers map it to their usual error. */
export class RequestBodyTooLarge extends Error {
  override readonly name = "RequestBodyTooLarge";
  constructor() {
    super("Request body exceeds the size limit.");
  }
}

/**
 * The body parsed as JSON, read under `maxBytes`. Like `request.json()`, it
 * rejects on a body that is not JSON, and also on one over the cap.
 */
export const readBoundedJson = async (
  request: Request,
  maxBytes: number = MAX_JSON_REQUEST_BYTES,
): Promise<unknown> => {
  const text = await readBoundedText(request, maxBytes);
  if (text === undefined) throw new RequestBodyTooLarge();
  return JSON.parse(text) as unknown;
};

/**
 * The body parsed as form data, read under `maxBytes`; rejects like
 * `readBoundedJson`. The parser reads a counted stream, so a large form is
 * not first joined into one more copy.
 */
export const readBoundedFormData = async (
  request: Request,
  maxBytes: number,
): Promise<FormData> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new RequestBodyTooLarge();
  }
  const type = request.headers.get("content-type");
  const headers: Record<string, string> =
    type === null ? {} : { "content-type": type };
  if (request.body === null) return new Response("", { headers }).formData();
  let length = 0;
  let tooLarge = false;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.byteLength;
        if (length > maxBytes) {
          tooLarge = true;
          controller.error(new RequestBodyTooLarge());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(counted, { headers }).formData();
  } catch (error) {
    throw tooLarge ? new RequestBodyTooLarge() : error;
  }
};
