import { Schema } from "effect";
import type { Refusal } from "../http/endpoint.js";
import { ThreadArchivedResponseSchema } from "./archive-thread.js";
import { ThreadDeletedResponseSchema } from "./delete-thread.js";
import { ThreadNotFoundResponseSchema } from "./thread-not-found-response.js";

/**
 * A View member asked for what only contributors may do; the message says
 * which (a write, or the Orb's contents).
 */
export const ThreadReadOnlyResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("THREAD_READ_ONLY"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

/**
 * What `authorizeThread` refuses a `/v1/threads/:threadId/*` request with,
 * before the route runs. A thread-scoped endpoint lists these with its own.
 */
export const ThreadAccessRefusals = [
  { status: 404, schema: ThreadNotFoundResponseSchema },
  { status: 410, schema: ThreadDeletedResponseSchema },
  { status: 403, schema: ThreadReadOnlyResponseSchema },
] as const satisfies ReadonlyArray<Refusal>;

/**
 * What `enforceThreadActive` refuses a change to an archived Thread with
 * (its terminal, files, Desktop, and agent), for an endpoint behind it.
 */
export const ThreadActiveRefusals = [
  { status: 409, schema: ThreadArchivedResponseSchema },
] as const satisfies ReadonlyArray<Refusal>;
