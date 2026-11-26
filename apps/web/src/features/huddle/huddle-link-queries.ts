import { CreateHuddleLinkEndpoint, GetHuddleLinkTargetEndpoint } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { dxClient } from "../../shared/api/client.js";

/** `POST /v1/threads/:id/huddle/link`: the huddle's short link. */
export const postHuddleLink = async (threadId: string) =>
  (
    await dxClient.call(CreateHuddleLinkEndpoint, {
      params: { threadId: threadId as ThreadId },
    })
  ).data;

/** `GET /v1/huddle-links/:workspace/:code`: the thread or Space it opens. */
export const huddleLinkTargetQueryOptions = (workspace: string, code: string) =>
  queryOptions({
    queryKey: ["huddle", "link", workspace.toLowerCase(), code] as const,
    queryFn: async ({ signal }) =>
      (
        await dxClient.call(
          GetHuddleLinkTargetEndpoint,
          { params: { workspace, code } },
          { signal },
        )
      ).data,
    // Read fresh each time: sharing can change between visits.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

/** Copies the huddle's link, the same for everyone, and says so. */
export const copyHuddleLink = async (threadId: string) => {
  try {
    const link = await postHuddleLink(threadId);
    await navigator.clipboard.writeText(
      new URL(link.path, window.location.origin).href,
    );
    toast.success(`Huddle link copied: ${link.code}`);
  } catch (error) {
    toast.error(
      error instanceof Error && error.message !== ""
        ? error.message
        : "Could not copy the huddle link.",
    );
  }
};
