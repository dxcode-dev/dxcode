import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { ThreadAccessRefusals } from "../threads/thread-access-refusals.js";
import { ThreadNotFoundResponseSchema } from "../threads/thread-not-found-response.js";
import {
  CreateMessageCommentRequestSchema,
  MessageCommentErrorResponseSchema,
  MessageCommentListResponseSchema,
  MessageCommentResponseSchema,
  MessageCommentSummaryListResponseSchema,
} from "./message-comments.js";
import {
  ListSpacePostsQuerySchema,
  ListSpacePostsResponseSchema,
  SpacePostReactionSchema,
  SpacePostResponseSchema,
  SpacePostRevisionsResponseSchema,
  SpacePostTextRequestSchema,
} from "./posts.js";
import {
  SpaceProgressQuerySchema,
  SpaceProgressResponseSchema,
} from "./progress.js";
import { SpaceArtifactsResponseSchema } from "./space-artifacts.js";
import {
  SpaceCatchUpResponseSchema,
  SpaceThreadResponseSchema,
} from "./space-cards.js";
import {
  CreateSpaceRequestSchema,
  DiscoverSpacesQuerySchema,
  ListSpaceSuggestionsResponseSchema,
  ListSpacesResponseSchema,
  ListSpaceThreadsResponseSchema,
  SpaceErrorResponseSchema,
  SpaceParamsSchema,
  SpaceResponseSchema,
  UpdateSpaceRequestSchema,
} from "./space-data.js";

/**
 * The Spaces endpoints, apart from their schemas: a module that defines
 * endpoints ships whole with whatever imports it, so the Thread page, which
 * reads Space schemas, never loads these (wiki/headless-client.md).
 */

/**
 * What every `/v1/spaces` route refuses with: its own errors, and a Space
 * Thread hidden while the deployment turned Spaces off.
 */
export const SpaceRefusals = [
  // Space errors go out with each of these statuses (spaces/routes.ts).
  ...([400, 403, 404, 409, 503] as const).map((status) => ({
    status,
    schema: SpaceErrorResponseSchema,
  })),
  { status: 404, schema: ThreadNotFoundResponseSchema },
];

export const CreateSpaceEndpoint = defineEndpoint({
  id: "spaces.create",
  summary: "Create a Space",
  method: "POST",
  path: "/v1/spaces",
  body: CreateSpaceRequestSchema,
  success: SpaceResponseSchema,
  successStatus: 201,
  refusals: SpaceRefusals,
});

export const ListSpacesEndpoint = defineEndpoint({
  id: "spaces.list",
  summary: "List Spaces",
  method: "GET",
  path: "/v1/spaces",
  success: ListSpacesResponseSchema,
  refusals: SpaceRefusals,
});

export const DiscoverSpacesEndpoint = defineEndpoint({
  id: "spaces.discover",
  summary: "Discover Spaces to join",
  method: "GET",
  path: "/v1/spaces/discover",
  query: DiscoverSpacesQuerySchema,
  success: ListSpacesResponseSchema,
  refusals: SpaceRefusals,
});

export const ListSpaceSuggestionsEndpoint = defineEndpoint({
  id: "spaces.suggestions",
  summary: "Suggest Spaces",
  method: "GET",
  path: "/v1/spaces/suggestions",
  success: ListSpaceSuggestionsResponseSchema,
  refusals: SpaceRefusals,
});

export const GetSpaceEndpoint = defineEndpoint({
  id: "spaces.get",
  summary: "Read a Space",
  method: "GET",
  path: "/v1/spaces/:threadId",
  params: SpaceParamsSchema,
  success: SpaceResponseSchema,
  refusals: SpaceRefusals,
});

export const UpdateSpaceEndpoint = defineEndpoint({
  id: "spaces.update",
  summary: "Change a Space",
  method: "PATCH",
  path: "/v1/spaces/:threadId",
  params: SpaceParamsSchema,
  body: UpdateSpaceRequestSchema,
  success: SpaceResponseSchema,
  refusals: SpaceRefusals,
});

export const JoinSpaceEndpoint = defineEndpoint({
  id: "spaces.join",
  summary: "Join a Space",
  method: "POST",
  path: "/v1/spaces/:threadId/join",
  params: SpaceParamsSchema,
  success: SpaceResponseSchema,
  refusals: SpaceRefusals,
});

export const LeaveSpaceEndpoint = defineEndpoint({
  id: "spaces.leave",
  summary: "Leave a Space",
  method: "POST",
  path: "/v1/spaces/:threadId/leave",
  params: SpaceParamsSchema,
  success: SpaceResponseSchema,
  refusals: SpaceRefusals,
});

export const ListSpaceThreadsEndpoint = defineEndpoint({
  id: "spaces.threads",
  summary: "List a Space's Threads",
  method: "GET",
  path: "/v1/spaces/:threadId/threads",
  params: SpaceParamsSchema,
  success: ListSpaceThreadsResponseSchema,
  refusals: SpaceRefusals,
});

export const ListSpaceArtifactsEndpoint = defineEndpoint({
  id: "spaces.artifacts",
  summary: "List a Space's artifacts",
  method: "GET",
  path: "/v1/spaces/:threadId/artifacts",
  params: SpaceParamsSchema,
  success: SpaceArtifactsResponseSchema,
  refusals: SpaceRefusals,
});

export const GetSpaceThreadEndpoint = defineEndpoint({
  id: "spaces.thread",
  summary: "Read a Thread in a Space",
  method: "GET",
  path: "/v1/spaces/:threadId/threads/:childId",
  params: Schema.Struct({ threadId: ThreadId, childId: Schema.String }),
  success: SpaceThreadResponseSchema,
  refusals: SpaceRefusals,
});

export const GetSpaceCatchUpEndpoint = defineEndpoint({
  id: "spaces.catchUp",
  summary: "Read a Space's catch-up",
  method: "GET",
  path: "/v1/spaces/:threadId/catch-up",
  params: SpaceParamsSchema,
  success: SpaceCatchUpResponseSchema,
  refusals: SpaceRefusals,
});

export const DismissSpaceCatchUpEndpoint = defineEndpoint({
  id: "spaces.dismissCatchUp",
  summary: "Dismiss a Space's catch-up",
  method: "POST",
  path: "/v1/spaces/:threadId/catch-up/dismiss",
  params: SpaceParamsSchema,
  success: SpaceCatchUpResponseSchema,
  refusals: SpaceRefusals,
});

export const ListSpacePostsEndpoint = defineEndpoint({
  id: "spaces.posts.list",
  summary: "List a Space's posts",
  method: "GET",
  path: "/v1/spaces/:threadId/posts",
  params: SpaceParamsSchema,
  query: ListSpacePostsQuerySchema,
  success: ListSpacePostsResponseSchema,
  refusals: SpaceRefusals,
});

export const CreateSpacePostEndpoint = defineEndpoint({
  id: "spaces.posts.create",
  summary: "Post in a Space",
  method: "POST",
  path: "/v1/spaces/:threadId/posts",
  params: SpaceParamsSchema,
  body: SpacePostTextRequestSchema,
  success: SpacePostResponseSchema,
  successStatus: 201,
  refusals: SpaceRefusals,
});

export const ListSpacePostRevisionsEndpoint = defineEndpoint({
  id: "spaces.posts.revisions",
  summary: "List a Space post's revisions",
  method: "GET",
  path: "/v1/spaces/:threadId/posts/:postId/revisions",
  params: Schema.Struct({ threadId: ThreadId, postId: Schema.String }),
  success: SpacePostRevisionsResponseSchema,
  refusals: SpaceRefusals,
});

const SpacePostReactionParamsSchema = Schema.Struct({
  threadId: ThreadId,
  postId: Schema.String,
  reaction: SpacePostReactionSchema,
});

export const AddSpacePostReactionEndpoint = defineEndpoint({
  id: "spaces.posts.addReaction",
  summary: "React to a Space post",
  method: "PUT",
  path: "/v1/spaces/:threadId/posts/:postId/reactions/:reaction",
  params: SpacePostReactionParamsSchema,
  success: SpacePostResponseSchema,
  refusals: SpaceRefusals,
});

export const RemoveSpacePostReactionEndpoint = defineEndpoint({
  id: "spaces.posts.removeReaction",
  summary: "Remove a reaction from a Space post",
  method: "DELETE",
  path: "/v1/spaces/:threadId/posts/:postId/reactions/:reaction",
  params: SpacePostReactionParamsSchema,
  success: SpacePostResponseSchema,
  refusals: SpaceRefusals,
});

export const GetSpaceProgressEndpoint = defineEndpoint({
  id: "spaces.progress",
  summary: "Read a Space's progress",
  method: "GET",
  path: "/v1/spaces/:threadId/progress",
  params: SpaceParamsSchema,
  query: SpaceProgressQuerySchema,
  success: SpaceProgressResponseSchema,
  refusals: SpaceRefusals,
});

export const MessageCommentRefusals = [
  // Comment errors go out with each of these statuses
  // (spaces/message-comments/routes.ts).
  ...([400, 404, 409, 503] as const).map((status) => ({
    status,
    schema: MessageCommentErrorResponseSchema,
  })),
  ...ThreadAccessRefusals,
];

export const ListMessageCommentSummariesEndpoint = defineEndpoint({
  id: "messageComments.summaries",
  summary: "Count comments on a Thread's messages",
  method: "GET",
  path: "/v1/threads/:threadId/message-comments",
  params: Schema.Struct({ threadId: ThreadId }),
  success: MessageCommentSummaryListResponseSchema,
  refusals: MessageCommentRefusals,
});

const MessageCommentParamsSchema = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.String,
});

export const ListMessageCommentsEndpoint = defineEndpoint({
  id: "messageComments.list",
  summary: "List a message's comments",
  method: "GET",
  path: "/v1/threads/:threadId/message-comments/:messageId",
  params: MessageCommentParamsSchema,
  success: MessageCommentListResponseSchema,
  refusals: MessageCommentRefusals,
});

export const CreateMessageCommentEndpoint = defineEndpoint({
  id: "messageComments.create",
  summary: "Comment on a message",
  method: "POST",
  path: "/v1/threads/:threadId/message-comments/:messageId",
  params: MessageCommentParamsSchema,
  body: CreateMessageCommentRequestSchema,
  success: MessageCommentResponseSchema,
  successStatus: 201,
  refusals: MessageCommentRefusals,
});
