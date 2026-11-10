import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import type { CommentPeople } from "../../../shared/comments/comment-text.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";

/**
 * Who can be mentioned in a Space, and their names by user ID for the
 * mention chips its posts show: the Space Thread's members, the viewer
 * among them.
 */
export const useSpacePeople = (spaceThreadId: ThreadId) => {
  const { identity } = useAuthenticatedIdentity();
  const members =
    useQuery(threadMembersQueryOptions(identity.id, spaceThreadId)).data ?? [];
  const people: CommentPeople = new Map<
    string,
    { readonly name: string; readonly image?: string }
  >([
    [identity.id, { name: identity.name }],
    ...members.map(
      (member) =>
        [member.userId, { name: member.name, image: member.image }] as const,
    ),
  ]);
  return { members, people };
};
