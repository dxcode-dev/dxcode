import { Schema } from "effect";
import {
  defineEndpoint,
  FileAnswerSchema,
  NoContentSchema,
} from "../http/endpoint.js";
import { ThreadTerminalIdSchema } from "./terminal.js";
import {
  ThreadTerminalParamsSchema,
  ThreadTerminalRefusals,
} from "./terminal-session-endpoints.js";

/**
 * Attaching and warming the Terminal, apart from `terminal.ts`'s schemas
 * and from closing a session (`terminal-session-endpoints.ts`).
 */

/** Which Terminal to attach; absent for the first, `default`. */
export const ThreadTerminalQuerySchema = Schema.Struct({
  terminal: Schema.optional(ThreadTerminalIdSchema),
});

/**
 * The Terminal's WebSocket (subprotocol `THREAD_TERMINAL_SUBPROTOCOL`). A
 * client opens it at `endpointPath`; it is never `call`ed. Core answers
 * any request that is not a same-origin upgrade with 404.
 */
export const AttachThreadTerminalEndpoint = defineEndpoint({
  id: "threads.terminal.attach",
  summary: "Attach to a Terminal session (WebSocket)",
  method: "GET",
  path: "/v1/threads/:threadId/terminal",
  params: ThreadTerminalParamsSchema,
  query: ThreadTerminalQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: ThreadTerminalRefusals,
});

/**
 * Start waking the Orb for a Terminal about to open. Core answers 202 with
 * no body at once and keeps the wake running.
 */
export const WarmThreadTerminalEndpoint = defineEndpoint({
  id: "threads.terminal.warm",
  summary: "Start waking the Orb for a Terminal about to open",
  method: "POST",
  path: "/v1/threads/:threadId/terminal/warm",
  params: ThreadTerminalParamsSchema,
  success: NoContentSchema,
  answer: "none",
  successStatus: 202,
  refusals: ThreadTerminalRefusals,
});
