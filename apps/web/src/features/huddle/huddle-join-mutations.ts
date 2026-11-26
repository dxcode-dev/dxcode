import { JoinHuddleEndpoint } from "@dx/api";
import { dxClient } from "../../shared/api/client.js";
import { type HuddleScope, huddleThreadId } from "./huddle-client.js";

/** `POST /v1/threads/:id/huddle/join`: a RealtimeKit token for the caller. */
export const postHuddleJoin = async (scope: HuddleScope) =>
  (
    await dxClient.call(JoinHuddleEndpoint, {
      params: { threadId: huddleThreadId(scope) },
    })
  ).data;
