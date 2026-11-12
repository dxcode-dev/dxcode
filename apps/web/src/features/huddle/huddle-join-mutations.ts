import { HuddleErrorResponseSchema, HuddleJoinResponseSchema } from "@dx/api";
import { request } from "../../shared/api/client.js";
import { type HuddleScope, huddleThreadId } from "./huddle-client.js";

/** `POST /v1/threads/:id/huddle/join`: a RealtimeKit token for the caller. */
export const postHuddleJoin = async (scope: HuddleScope) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(huddleThreadId(scope))}/huddle/join`,
      HuddleJoinResponseSchema,
      { method: "POST" },
      HuddleErrorResponseSchema,
    )
  ).data;
