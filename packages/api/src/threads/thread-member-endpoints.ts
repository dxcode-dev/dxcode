import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";
import {
  GetThreadMembersResponseSchema,
  ThreadFollowResponseSchema,
} from "./thread-chat.js";
import { ThreadSharingErrorResponseSchema } from "./thread-sharing.js";

/**
 * A shared Thread's members and following it. Apart from thread-chat.ts,
 * which ThreadDataSchema imports, so the refusals this needs (archive-thread
 * through ThreadAccessRefusals) form no import cycle.
 */

export const ThreadMembersParamsSchema = Schema.Struct({ threadId: ThreadId });

/** `authorizeThread`'s refusals, and the route's own while persistence is down. */
const threadMemberRefusals = [
  ...ThreadAccessRefusals,
  { status: 503, schema: ThreadSharingErrorResponseSchema },
];

export const GetThreadMembersEndpoint = defineEndpoint({
  id: "threads.members",
  method: "GET",
  path: "/v1/threads/:threadId/members",
  params: ThreadMembersParamsSchema,
  success: GetThreadMembersResponseSchema,
  refusals: threadMemberRefusals,
});

export const FollowThreadEndpoint = defineEndpoint({
  id: "threads.follow",
  method: "PUT",
  path: "/v1/threads/:threadId/follow",
  params: ThreadMembersParamsSchema,
  success: ThreadFollowResponseSchema,
  refusals: threadMemberRefusals,
});

export const UnfollowThreadEndpoint = defineEndpoint({
  id: "threads.unfollow",
  method: "DELETE",
  path: "/v1/threads/:threadId/follow",
  params: ThreadMembersParamsSchema,
  success: ThreadFollowResponseSchema,
  refusals: threadMemberRefusals,
});
