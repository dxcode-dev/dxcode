import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { ThreadChangesParamsSchema } from "./changes.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/**
 * Apart from the other Changes endpoints: the Changes pane opens this
 * socket on the Thread page's first load and loads the rest when it reads.
 */

/**
 * The Changes pane's hint socket (`dx-changes-v1`): a WebSocket upgrade,
 * so a client opens `endpointPath` of it and never `call`s it.
 */
export const ThreadChangesEventsEndpoint = defineEndpoint({
  id: "threads.changes.events",
  summary: "Hints when the Thread's changes move (WebSocket)",
  method: "GET",
  path: "/v1/threads/:threadId/changes/events",
  params: ThreadChangesParamsSchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: ThreadAccessRefusals,
});
