import {
  type CommentedMessage,
  type CreateMessageCommentRequest,
  type MessageComment,
  MessageCommentListResponseSchema,
  MessageCommentResponseSchema,
  type MessageCommentSummary,
  MessageCommentSummaryListResponseSchema,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { request } from "../../../shared/api/client.js";
import {
  invalidateMessageComments,
  messageCommentKeys,
} from "./message-comments-cache-queries.js";

const staleTime = 30_000;
const gcTime = 5 * 60_000;

const commentsPath = (threadId: ThreadId, messageId?: string) =>
  `/v1/threads/${encodeURIComponent(threadId)}/message-comments${
    messageId === undefined ? "" : `/${encodeURIComponent(messageId)}`
  }`;

/** Every commented message of a Space, in the order the messages were sent. */
const listSummaries = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ReadonlyArray<MessageCommentSummary>> =>
  (
    await request(
      commentsPath(threadId),
      MessageCommentSummaryListResponseSchema,
      { signal },
    )
  ).data.items;

/** One message's comments, oldest first, and the message as commented. */
const listComments = async (
  threadId: ThreadId,
  messageId: string,
  signal?: AbortSignal,
): Promise<{
  readonly message: CommentedMessage | null;
  readonly comments: ReadonlyArray<MessageComment>;
}> =>
  (
    await request(
      commentsPath(threadId, messageId),
      MessageCommentListResponseSchema,
      { signal },
    )
  ).data;

const addComment = async (
  threadId: ThreadId,
  messageId: string,
  input: CreateMessageCommentRequest,
): Promise<MessageComment> =>
  (
    await request(
      commentsPath(threadId, messageId),
      MessageCommentResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data.comment;

export const messageCommentSummariesQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  queryOptions({
    queryKey: messageCommentKeys.summaries(userId, threadId),
    queryFn: ({ signal }) => listSummaries(threadId, signal),
    staleTime,
    gcTime,
  });

export const messageCommentsQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
  messageId: string,
) =>
  queryOptions({
    queryKey: messageCommentKeys.message(userId, threadId, messageId),
    queryFn: ({ signal }) => listComments(threadId, messageId, signal),
    staleTime,
    gcTime,
  });

/** Posts a comment; the comment shows at once, and the Space's list refreshes. */
export const useAddMessageComment = (userId: UserId, threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...messageCommentKeys.thread(userId, threadId), "add"],
    mutationFn: (input: {
      readonly messageId: string;
      readonly request: CreateMessageCommentRequest;
    }) => addComment(threadId, input.messageId, input.request),
    onSuccess: (comment) => {
      client.setQueryData(
        messageCommentKeys.message(userId, threadId, comment.messageId),
        (
          current:
            | {
                readonly message: CommentedMessage | null;
                readonly comments: ReadonlyArray<MessageComment>;
              }
            | undefined,
        ) =>
          current === undefined ||
          current.comments.some(({ id }) => id === comment.id)
            ? current
            : { ...current, comments: [...current.comments, comment] },
      );
      void invalidateMessageComments(client, userId, threadId);
    },
  });
};
