import { UserId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Who a message in a shared Thread is for. In `agent` mode a message goes to
 * the agent; in `chat` mode it is recorded for everyone in the Thread and no
 * model call happens. Tagging a member switches to chat, tagging @dx
 * switches back, and an untagged message keeps the current mode. A private
 * Thread is always in agent mode.
 */
export const ThreadConversationModeSchema = Schema.Literals(["agent", "chat"]);

export type ThreadConversationMode = typeof ThreadConversationModeSchema.Type;

/**
 * A member of the workspace a Thread is shared with: who can be tagged, and
 * how tagged members and message authors are shown. The email is for the
 * member card only; it never reaches the agent.
 */
export const ThreadMemberDataSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String.check(Schema.isMaxLength(256)),
  handle: Schema.String.check(Schema.isMaxLength(64)),
  email: Schema.String.check(Schema.isMaxLength(320)),
  image: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});

export type ThreadMemberData = typeof ThreadMemberDataSchema.Type;

/**
 * `GET /v1/threads/:threadId/members`: active members of the workspace the
 * Thread is shared with, the owner included; none while it is private.
 */
export const GetThreadMembersResponseSchema = successResponse(
  Schema.Struct({ members: Schema.Array(ThreadMemberDataSchema) }),
);

export type GetThreadMembersResponseData =
  (typeof GetThreadMembersResponseSchema.Type)["data"];

/** `PUT` / `DELETE /v1/threads/:threadId/follow` for a shared Thread. */
export const ThreadFollowResponseSchema = successResponse(
  Schema.Struct({ following: Schema.Boolean }),
);
