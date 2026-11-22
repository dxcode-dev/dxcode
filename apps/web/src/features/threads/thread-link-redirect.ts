import { parseCommentLinkId } from "@dx/api";
import { artifactLinkHere } from "../../shared/navigation/open-artifact.js";

/**
 * Where a Thread link belongs instead, for the route to redirect to with
 * `replace`, or undefined to stay:
 * - A comment's link opens its post's Comments panel at the comment.
 * - A notification links to its artifact full screen, which a phone
 *   shows; a wide page shows it in the Thread's Artifacts view instead
 *   (not while preloading, which must not change the view).
 */
export const threadLinkRedirect = ({
  href,
  message,
  preload,
}: {
  readonly href: string;
  readonly message: string | undefined;
  readonly preload: boolean;
}): string | undefined => {
  const opened = new URL(href, window.location.origin);
  const comment =
    message === undefined ? undefined : parseCommentLinkId(message);
  if (comment !== undefined) {
    opened.searchParams.delete("message");
    opened.searchParams.set("comments", comment.postId);
    opened.searchParams.set("comment", comment.commentId);
    return opened.pathname + opened.search + opened.hash;
  }
  if (preload) return undefined;
  const here = artifactLinkHere(opened);
  return here === opened ? undefined : here.pathname + here.search + here.hash;
};
