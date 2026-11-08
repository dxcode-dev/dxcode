import { GetThreadDesktopResponseSchema } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { ApiError, request } from "../../shared/api/client.js";

export const desktopPath = (threadId: ThreadId) =>
  `/v1/threads/${encodeURIComponent(threadId)}/desktop`;

export type DesktopAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Starts the Thread's desktop through Core and says whether it can stream.
 * Each call is an action (it may wake the workspace and start the desktop),
 * so the viewer runs it on connect and retry rather than caching it. A
 * desktop that has not answered within one start's time limit is asked
 * once more before it counts as failed: an Orb just resumed from a disk
 * snapshot (Boat) can take longer to start it, and a second start waits for
 * that same session instead of starting another.
 */
export const checkDesktop = async (
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<DesktopAvailability> => {
  try {
    const check = () =>
      request(desktopPath(threadId), GetThreadDesktopResponseSchema, {
        signal,
      });
    let { data } = await check();
    if (data.desktop === "unavailable") ({ data } = await check());
    if (data.desktop === "ready") return { kind: "ready" };
    if (data.desktop === "unsupported") return { kind: "unsupported" };
    return { kind: "failed", message: "The desktop didn't start." };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      return {
        kind: "failed",
        message: "Unarchive the Thread to use its desktop.",
      };
    if (error instanceof ApiError && error.status === 403)
      return {
        kind: "failed",
        message: "Only contributors can use the desktop.",
      };
    return { kind: "failed", message: "The desktop couldn't be reached." };
  }
};
