import { Schema, SchemaTransformation } from "effect";

const uuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const canonicalThreadIdPattern = new RegExp(`^thr_(${uuidPattern})$`);
const threadIdInputPattern = new RegExp(`^(?:thr_|t-)(${uuidPattern})$`);
const threadReferencePattern = new RegExp(
  `(?:^|[^0-9A-Za-z_-])(?:thr_|t-)(${uuidPattern})(?![0-9A-Za-z_-])`,
  "i",
);

/**
 * Only the stored form, `thr_<uuid>`, for schemas that embed a Thread ID in a
 * larger string such as a template literal, where a transformation cannot go.
 */
export const StoredThreadId = Schema.String.check(
  Schema.isPattern(canonicalThreadIdPattern),
).pipe(Schema.brand("@dx/ThreadId"));

/**
 * Decodes a Thread ID written as `thr_<uuid>` (stored) or `t-<uuid>` (public)
 * and always produces the stored `thr_<uuid>` form.
 */
export const ThreadId = Schema.String.check(
  Schema.isPattern(threadIdInputPattern),
).pipe(
  Schema.decodeTo(
    StoredThreadId,
    SchemaTransformation.transform({
      decode: (input: string) => `thr_${uuidOf(input)}`,
      encode: (id: string) => id,
    }),
  ),
);

export type ThreadId = typeof ThreadId.Type;

export const newThreadId = () =>
  Schema.decodeUnknownSync(ThreadId)(`thr_${crypto.randomUUID()}`);

/** The public form `t-<uuid>` of a Thread ID given as `thr_<uuid>` or `t-<uuid>`. */
export const publicThreadId = (id: string): string => {
  const match = threadIdInputPattern.exec(id);
  return match ? `t-${match[1]}` : id;
};

/**
 * Finds a Thread ID in either form, alone or inside text such as a dx Thread
 * URL (`.../threads/<id>`), and returns the stored `thr_<uuid>` form.
 */
export const parseThreadReference = (text: string): ThreadId | undefined => {
  const match = threadReferencePattern.exec(text.trim());
  if (!match?.[1]) return undefined;
  return Schema.decodeUnknownSync(ThreadId)(`thr_${match[1].toLowerCase()}`);
};

const uuidOf = (input: string) =>
  input.startsWith("thr_") ? input.slice(4) : input.slice(2);
