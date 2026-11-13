import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Avatar } from "../../../shared/ui/avatar.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { messageCommentSummariesQueryOptions } from "./message-comments-queries.js";
import "./message-comments.css";

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * The Space panel's Comments tab: one row per commented message, in chat
 * order. A row opens that message's comments over the chat.
 */
export function SpaceCommentsTab({
  spaceThreadId,
  onOpen,
}: {
  readonly spaceThreadId: ThreadId;
  /** Shows the Space chat the comments open over. */
  readonly onOpen: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const navigate = useNavigate();
  const summaries = useQuery(
    messageCommentSummariesQueryOptions(identity.id, spaceThreadId),
  );
  if (summaries.isPending) return null;
  const items = summaries.data ?? [];
  if (items.length === 0)
    return (
      <EmptyState
        title="No Comments Yet"
        description="Comments people leave on this Space's messages show up here."
      />
    );
  return (
    <ul className="space-comments-list" aria-label="Commented messages">
      {items.map((item) => {
        const author = item.lastComment.author;
        return (
          <li key={item.message.messageId}>
            <button
              type="button"
              className="space-comments-row"
              onClick={() => {
                onOpen();
                void navigate({
                  to: "/threads/$threadId",
                  params: { threadId: spaceThreadId },
                  search: (previous: Record<string, unknown>) => ({
                    ...previous,
                    comments: item.message.messageId,
                  }),
                });
              }}
            >
              <MessagesSquare aria-hidden="true" />
              <span className="space-comments-row-text">
                <span className="space-comments-row-message">
                  {item.message.excerpt.replaceAll(/\s+/g, " ")}
                </span>
                <span className="space-comments-row-last">
                  {author === null ? "Former member" : firstName(author.name)}:{" "}
                  {item.lastComment.excerpt} ·{" "}
                  <TimeText
                    text={(now) =>
                      formatRelativeTime(
                        { epochMilliseconds: item.lastComment.createdAt },
                        now,
                      )
                    }
                  />
                </span>
              </span>
              {author === null ? null : (
                <Avatar
                  name={author.name}
                  seed={author.userId}
                  {...(author.avatarUrl === undefined
                    ? {}
                    : { image: author.avatarUrl })}
                />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
