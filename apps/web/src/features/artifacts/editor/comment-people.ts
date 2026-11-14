import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import type { CommentPeople } from "../../../shared/comments/comment-text.js";
import { artifactMembersOptions } from "../artifact-comments-queries.js";
import type { ArtifactScope } from "../artifact-scope.js";

/**
 * Who can be named in the Thread's comments, by user ID: its members, which
 * `@` lists, with their pictures, and the signed-in person, whom a private
 * Thread's member list leaves out. Others show initials and plain names.
 */
export const useCommentPeople = (
  viewer: { readonly id: UserId; readonly name: string },
  threadId: ArtifactScope,
): CommentPeople => {
  const members = useQuery(artifactMembersOptions(viewer.id, threadId));
  return new Map<string, { readonly name: string; readonly image?: string }>([
    [viewer.id, { name: viewer.name }],
    ...(members.data ?? []).map(
      (member) =>
        [member.userId, { name: member.name, image: member.image }] as const,
    ),
  ]);
};
