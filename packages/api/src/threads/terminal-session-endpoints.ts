import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, NoContentSchema } from "../http/endpoint.js";
import { NotFoundResponseSchema } from "../http/not-found-response.js";
import {
  CloseThreadTerminalRequestSchema,
  ThreadTerminalRunnerOwnerOnlyResponseSchema,
} from "./terminal.js";
import {
  ThreadAccessRefusals,
  ThreadActiveRefusals,
} from "./thread-access-refusals.js";

/**
 * Ending a Terminal's session, apart from the other Terminal endpoints: the
 * pane layout closes sessions on the Thread page's first load, which then
 * carries only this one.
 */

export const ThreadTerminalParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

/** What every Terminal route refuses before its own work. */
export const ThreadTerminalRefusals = [
  ...ThreadAccessRefusals,
  ...ThreadActiveRefusals,
  { status: 403, schema: ThreadTerminalRunnerOwnerOnlyResponseSchema },
  { status: 404, schema: NotFoundResponseSchema },
] as const;

/** End a closed tab's shell session; Core answers 204 with no body. */
export const CloseThreadTerminalEndpoint = defineEndpoint({
  id: "threads.terminal.close",
  summary: "End a closed tab's shell session",
  method: "POST",
  path: "/v1/threads/:threadId/terminal/close",
  params: ThreadTerminalParamsSchema,
  body: CloseThreadTerminalRequestSchema,
  success: NoContentSchema,
  answer: "none",
  successStatus: 204,
  refusals: ThreadTerminalRefusals,
});
