import { Schema } from "effect";

export const ThreadId = Schema.String.check(
  Schema.isPattern(
    /^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/ThreadId"));

export type ThreadId = typeof ThreadId.Type;

export const newThreadId = () =>
  Schema.decodeUnknownSync(ThreadId)(`thr_${crypto.randomUUID()}`);
