import type { UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Whether the Thread route must ask `thread-link-redirect.ts` where a link
 * belongs before it shows the page: a comment's link
 * (`?message=pst_….<hex>`) or a notification's artifact opened full screen
 * (`?sheet=artifact`). Other Thread URLs never load that module.
 */
export const mayRedirectThreadLink = (search: {
  readonly message?: string;
  readonly sheet?: string;
}) =>
  search.sheet === "artifact" ||
  (search.message?.startsWith("pst_") === true && search.message.includes("."));

/**
 * Entering a Space at a mention's link (`?message=pst_…`): older posts load
 * until the linked one arrives, so the chat can open at it.
 */
export const openLinkedSpacePost = (
  queryClient: QueryClient,
  userId: UserId,
  spaceThreadId: string,
  message: string | undefined,
) => {
  if (message === undefined || !message.startsWith("pst_")) return;
  void import("../spaces/posts/space-posts-queries.js").then(
    ({ loadLinkedSpacePost }) =>
      loadLinkedSpacePost(queryClient, userId, spaceThreadId, message),
  );
};
