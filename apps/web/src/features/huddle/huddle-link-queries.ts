import {
  HuddleErrorResponseSchema,
  HuddleLinkResponseSchema,
  HuddleLinkTargetResponseSchema,
} from "@dx/api";
import { queryOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, request } from "../../shared/api/client.js";

/** `POST /v1/threads/:id/huddle/link`: the huddle's short link. */
export const postHuddleLink = async (threadId: string) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/huddle/link`,
      HuddleLinkResponseSchema,
      { method: "POST" },
      HuddleErrorResponseSchema,
    )
  ).data;

/** `GET /v1/huddle-links/:workspace/:code`: the thread or Space it opens. */
export const huddleLinkTargetQueryOptions = (workspace: string, code: string) =>
  queryOptions({
    queryKey: ["huddle", "link", workspace.toLowerCase(), code] as const,
    queryFn: async ({ signal }) =>
      (
        await request(
          `/v1/huddle-links/${encodeURIComponent(workspace)}/${encodeURIComponent(code)}`,
          HuddleLinkTargetResponseSchema,
          { signal },
          HuddleErrorResponseSchema,
        )
      ).data,
    // Read fresh each time: sharing can change between visits.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

/** The deployment has no RealtimeKit app, so a link cannot open a huddle. */
export class HuddlesOffError extends Error {
  constructor() {
    super("Huddles are not available on this dx.");
    this.name = "HuddlesOffError";
  }
}

/** Why a huddle link did not open, for its page. */
export const huddleLinkFailure = (
  error: unknown,
):
  | "off"
  | "HUDDLE_LINK_NOT_FOUND"
  | "HUDDLE_LINK_FORBIDDEN"
  | "HUDDLE_PRIVATE"
  | undefined => {
  if (error instanceof HuddlesOffError) return "off";
  const code = error instanceof ApiError ? error.code : undefined;
  return code === "HUDDLE_LINK_NOT_FOUND" ||
    code === "HUDDLE_LINK_FORBIDDEN" ||
    code === "HUDDLE_PRIVATE"
    ? code
    : undefined;
};

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
